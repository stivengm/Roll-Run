import {
  computed,
  DestroyRef,
  effect,
  inject,
  Injectable,
  signal,
  untracked,
} from '@angular/core';
import { Router } from '@angular/router';
import { formatRoomCode } from '../../../../shared/protocol';
import type {
  JoinResult,
  PlayerView,
  RoomSettings,
  RoomView,
  SessionInfo,
} from '../../../../shared/protocol';
import { ProfileService } from './profile.service';
import { isRejection, ServerError, SocketService } from './socket.service';
import { ToastService } from './toast.service';

/** sessionStorage: cada pestaña es un jugador distinto y sobrevive a recargas. */
const SESSION_KEY = 'rr.session';
/** Silla abandonada sin poder avisar al servidor: se libera en la próxima conexión. */
const PENDING_LEAVE_KEY = 'rr.pendingLeave';
/** Espera entre reintentos de recuperar la silla cuando el servidor no responde. */
const RETRY_DELAYS_MS = [1000, 2000, 4000, 8000];

/** `pending`: aún sin respuesta (sin conexión o reintentando); la sala llegará sola al store. */
export type EnsureRoomResult = 'ok' | 'no-session' | 'failed' | 'pending';

/** `stale`: la sesión cambió mientras esperábamos (p. ej. el jugador salió): nada que hacer. */
type RejoinResult = 'ok' | 'rejected' | 'retry' | 'stale';

const SEAT_LOST_MESSAGE = 'La sala ya no existe o tu sesión expiró.';

function sameSeat(a: SessionInfo | null, b: SessionInfo): boolean {
  return !!a && a.code === b.code && a.playerId === b.playerId && a.token === b.token;
}

function readSession(key: string): SessionInfo | null {
  try {
    const raw = JSON.parse(sessionStorage.getItem(key) ?? 'null') as SessionInfo | null;
    return raw && raw.code && raw.playerId && raw.token ? raw : null;
  } catch {
    return null;
  }
}

function writeSession(key: string, session: SessionInfo | null): void {
  try {
    if (session) {
      sessionStorage.setItem(key, JSON.stringify(session));
    } else {
      sessionStorage.removeItem(key);
    }
  } catch {
    // Sin almacenamiento: vive solo en memoria.
  }
}

/**
 * Estado global de la sala actual. El servidor es la fuente de verdad: este store solo guarda
 * el último `RoomView` recibido y expone acciones que emiten eventos con ack.
 */
@Injectable({ providedIn: 'root' })
export class GameStore {
  private readonly socket = inject(SocketService);
  private readonly profile = inject(ProfileService);
  private readonly toast = inject(ToastService);
  private readonly router = inject(Router);

  readonly room = signal<RoomView | null>(null);
  readonly session = signal<SessionInfo | null>(readSession(SESSION_KEY));
  /** `true` mientras una acción espera respuesta del servidor (para deshabilitar botones). */
  readonly busy = signal(false);
  readonly connection = this.socket.status;
  readonly online = computed(() => this.connection() === 'online');

  readonly players = computed<PlayerView[]>(() => this.room()?.players ?? []);
  readonly me = computed(() => {
    const id = this.session()?.playerId;
    return this.players().find((p) => p.id === id) ?? null;
  });
  readonly isHost = computed(() => {
    const room = this.room();
    return !!room && room.hostId === this.session()?.playerId;
  });
  readonly host = computed(() => {
    const room = this.room();
    return room ? (room.players.find((p) => p.id === room.hostId) ?? null) : null;
  });
  readonly currentPlayer = computed(() => {
    const turn = this.room()?.turn;
    return turn ? (this.players().find((p) => p.id === turn.playerId) ?? null) : null;
  });
  readonly isMyTurn = computed(() => {
    const room = this.room();
    return room?.status === 'playing' && room.turn?.playerId === this.session()?.playerId;
  });
  /** Sin conexión no se ofrece la acción: se enviaría a un socket todavía sin silla. */
  readonly canRoll = computed(
    () => this.isMyTurn() && this.room()?.phase === 'idle' && this.online(),
  );
  readonly canPass = computed(
    () => this.canRoll() && (this.room()?.turn?.rolls.length ?? 0) > 0,
  );
  /** Jugadores ordenados por score (desempata el orden de ingreso). */
  readonly leaderboard = computed(() =>
    this.players()
      .map((p, index) => ({ player: p, order: index + 1 }))
      .sort((a, b) => b.player.score - a.player.score || a.order - b.order),
  );
  readonly connectedCount = computed(() => this.players().filter((p) => p.connected).length);

  /** El socket actual ocupa la silla de `session` en el servidor. */
  private bound = false;
  private rejoining: { token: string; promise: Promise<RejoinResult> } | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retries = 0;
  private pendingLeave = readSession(PENDING_LEAVE_KEY);
  private releasing = false;
  private turnNotified: string | null = null;
  private rejection: string | null = null;

  constructor() {
    this.socket.on('room:state', (room) => {
      if (room.code === this.session()?.code) {
        this.room.set(room);
      }
    });

    this.socket.on('room:kicked', ({ reason }) => {
      this.clear();
      this.toast.show(reason, 'warning', 4500, 'logout');
      void this.router.navigateByUrl('/', { replaceUrl: true });
    });

    // Tras una reconexión (o al abrir la app con sesión guardada) recuperamos la silla.
    this.socket.onConnect(() => {
      this.retries = 0;
      this.flushPendingLeave();
      if (this.session()) {
        void this.restoreSeat();
      }
    });

    this.socket.onDisconnect(() => {
      this.bound = false;
      this.cancelRetry();
    });

    inject(DestroyRef).onDestroy(() => this.cancelRetry());

    // Si es mi turno y no estoy en la pantalla de la sala, aviso (la partida me espera).
    effect(() => {
      const room = this.room();
      const mine = this.isMyTurn();
      untracked(() => this.notifyTurnAway(room, mine));
    });
  }

  // ------------------------------------------------------------------ Sala

  async createRoom(settings: RoomSettings): Promise<string> {
    const result = await this.run(() =>
      this.socket.request('room:create', { profile: this.profile.snapshot(), settings }),
    );
    this.adopt(result);
    return result.session.code;
  }

  async joinRoom(code: string): Promise<string> {
    const result = await this.run(() =>
      this.socket.request('room:join', { code, profile: this.profile.snapshot() }),
    );
    this.adopt(result);
    return result.session.code;
  }

  /**
   * Garantiza que el store tenga la sala `code` cargada: usa la que ya tiene o
   * se reconecta con la sesión guardada en esta pestaña.
   */
  async ensureRoom(code: string): Promise<EnsureRoomResult> {
    if (this.room()?.code === code) {
      return 'ok';
    }
    if (this.session()?.code !== code) {
      return 'no-session';
    }
    if (!this.socket.connected) {
      // El rejoin sale al conectar (onConnect); emitirlo ahora solo lo dejaría en el buffer.
      return 'pending';
    }
    const result = await this.rejoin();
    return result === 'ok' ? 'ok' : result === 'rejected' ? 'failed' : 'pending';
  }

  /** Sale de la sala. Localmente es inmediato; el servidor se entera en cuanto haya conexión. */
  async leave(): Promise<void> {
    const session = this.session();
    const bound = this.bound;
    this.clear();
    if (!session) {
      return;
    }
    if (!bound) {
      this.releaseSeat(session);
      return;
    }
    try {
      await this.run(() => this.socket.request('room:leave', {}));
    } catch (err) {
      // Sin respuesta no sabemos si el servidor lo procesó: se reintenta de forma segura.
      if (!(err instanceof ServerError)) {
        this.releaseSeat(session);
      }
    }
  }

  kick(playerId: string): Promise<void> {
    return this.action(() => this.socket.request('room:kick', { playerId }));
  }

  updateSettings(settings: RoomSettings): Promise<void> {
    return this.action(() => this.socket.request('room:settings', { settings }));
  }

  // ------------------------------------------------------------------ Partida

  start(): Promise<void> {
    return this.action(() => this.socket.request('game:start', {}));
  }

  roll(): Promise<void> {
    return this.action(() => this.socket.request('game:roll', {}));
  }

  pass(): Promise<void> {
    return this.action(() => this.socket.request('game:pass', {}));
  }

  skip(): Promise<void> {
    return this.action(() => this.socket.request('game:skip', {}));
  }

  restart(): Promise<void> {
    return this.action(() => this.socket.request('game:restart', {}));
  }

  playerById(id: string | null | undefined): PlayerView | null {
    return this.players().find((p) => p.id === id) ?? null;
  }

  /** Posición (1-based) del jugador en el orden de ingreso / turnos. */
  orderOf(id: string): number {
    return this.players().findIndex((p) => p.id === id) + 1;
  }

  /** Motivo con el que el servidor rechazó la última reconexión (p. ej. la partida empezó sin ti). */
  get rejectionMessage(): string {
    return this.rejection ?? SEAT_LOST_MESSAGE;
  }

  // ------------------------------------------------------------------ Internos

  /** Recupera la silla de la sesión; si el servidor ya no la reconoce, vuelve al inicio. */
  private async restoreSeat(): Promise<RejoinResult> {
    const result = await this.rejoin();
    if (
      result === 'rejected' &&
      this.router.url.startsWith('/sala') &&
      !this.router.currentNavigation()
    ) {
      this.toast.show(this.rejectionMessage, 'warning', 4200);
      void this.router.navigateByUrl('/', { replaceUrl: true });
    }
    return result;
  }

  /**
   * `room:rejoin` con la sesión guardada. Solo un rechazo del servidor borra la sesión:
   * ante un corte o un timeout se conserva y se reintenta.
   */
  private rejoin(): Promise<RejoinResult> {
    const session = this.session();
    if (!session) {
      return Promise.resolve('stale');
    }
    if (this.rejoining?.token === session.token) {
      return this.rejoining.promise;
    }
    this.cancelRetry();
    const promise: Promise<RejoinResult> = this.socket
      .request('room:rejoin', session)
      .then(
        (result): RejoinResult => {
          if (!sameSeat(this.session(), session)) {
            return 'stale';
          }
          this.adopt(result);
          return 'ok';
        },
        (err: unknown): RejoinResult => {
          if (!sameSeat(this.session(), session)) {
            return 'stale';
          }
          if (isRejection(err)) {
            this.clear();
            this.rejection = err.message;
            return 'rejected';
          }
          this.scheduleRetry();
          return 'retry';
        },
      )
      .finally(() => {
        if (this.rejoining?.promise === promise) {
          this.rejoining = null;
        }
      });
    this.rejoining = { token: session.token, promise };
    return promise;
  }

  /** Con conexión pero sin respuesta (servidor lento, conexión a medias): reintenta con espera. */
  private scheduleRetry(): void {
    if (this.retryTimer !== null || !this.socket.connected) {
      return;
    }
    const delay = RETRY_DELAYS_MS[Math.min(this.retries, RETRY_DELAYS_MS.length - 1)];
    this.retries++;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.session() && !this.bound && this.socket.connected) {
        void this.restoreSeat();
      }
    }, delay);
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private releaseSeat(session: SessionInfo): void {
    this.pendingLeave = session;
    writeSession(PENDING_LEAVE_KEY, session);
    this.flushPendingLeave();
  }

  /** Libera en el servidor una silla abandonada: rejoin + leave seguidos en el mismo socket. */
  private flushPendingLeave(): void {
    const pending = this.pendingLeave;
    // Ligado a la sesión actual, un rejoin a otra silla nos sacaría de la sala en la que estamos.
    if (!pending || this.releasing || this.bound || !this.socket.connected) {
      return;
    }
    this.releasing = true;
    // Se emiten sin esperar: el servidor los procesa en orden, antes que cualquier otra acción.
    const rejoin = this.socket.request('room:rejoin', pending);
    const leave = this.socket.request('room:leave', {});
    void Promise.allSettled([rejoin, leave]).then(([joined, left]) => {
      this.releasing = false;
      const done =
        joined.status === 'fulfilled' ? left.status === 'fulfilled' : isRejection(joined.reason);
      if (done && this.pendingLeave?.token === pending.token) {
        this.pendingLeave = null;
        writeSession(PENDING_LEAVE_KEY, null);
      }
    });
  }

  private notifyTurnAway(room: RoomView | null, mine: boolean): void {
    const turn = room?.turn;
    if (!room || !turn || !mine) {
      return;
    }
    const key = `${room.round}:${turn.number}`;
    if (key === this.turnNotified) {
      return;
    }
    this.turnNotified = key;
    const path = this.router.url.split(/[?#]/)[0];
    if (room.phase === 'idle' && turn.rolls.length === 0 && path !== `/sala/${room.code}`) {
      this.toast.show(
        `¡Es tu turno en la sala ${formatRoomCode(room.code)}! Vuelve para jugar.`,
        'warning',
        6000,
        'casino',
      );
    }
  }

  /** Ejecuta una acción mostrando el error en un toast (no relanza). */
  private async action(fn: () => Promise<unknown>): Promise<void> {
    try {
      await this.run(fn);
    } catch (err) {
      this.toast.fromError(err);
    }
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    this.busy.set(true);
    try {
      return await fn();
    } finally {
      this.busy.set(false);
    }
  }

  private adopt({ session, room }: JoinResult): void {
    this.rejection = null;
    this.session.set(session);
    this.room.set(room);
    this.bound = true;
    this.retries = 0;
    this.cancelRetry();
    writeSession(SESSION_KEY, session);
  }

  private clear(): void {
    this.session.set(null);
    this.room.set(null);
    this.bound = false;
    this.cancelRetry();
    writeSession(SESSION_KEY, null);
  }
}
