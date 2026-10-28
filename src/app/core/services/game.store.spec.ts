import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import {
  DEFAULT_SETTINGS,
  type JoinResult,
  type PlayerView,
  type RoomView,
  type SessionInfo,
} from '../../../../shared/protocol';
import { GameStore } from './game.store';
import { ProfileService } from './profile.service';
import {
  ServerError,
  SocketService,
  TransportError,
  type ConnectionStatus,
} from './socket.service';
import { ToastService } from './toast.service';

/** Sustituto de SocketService: registra peticiones y permite simular eventos del servidor. */
class FakeSocket {
  readonly status = signal<ConnectionStatus>('online');
  connected = true;
  readonly request = vi.fn<(event: string, payload: unknown) => Promise<unknown>>();
  private readonly handlers = new Map<string, (payload: never) => void>();
  private readonly connectHandlers: (() => void)[] = [];
  private readonly disconnectHandlers: (() => void)[] = [];

  on(event: string, handler: (payload: never) => void): () => void {
    this.handlers.set(event, handler);
    return () => this.handlers.delete(event);
  }

  onConnect(handler: () => void): () => void {
    this.connectHandlers.push(handler);
    return () => undefined;
  }

  onDisconnect(handler: () => void): () => void {
    this.disconnectHandlers.push(handler);
    return () => undefined;
  }

  emit(event: string, payload: unknown): void {
    this.handlers.get(event)?.(payload as never);
  }

  goOffline(): void {
    this.connected = false;
    this.status.set('offline');
    this.disconnectHandlers.forEach((h) => h());
  }

  goOnline(): void {
    this.connected = true;
    this.status.set('online');
    this.connectHandlers.forEach((h) => h());
  }

  events(): string[] {
    return this.request.mock.calls.map(([event]) => event);
  }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const SESSION: SessionInfo = { code: '882109', playerId: 'p1', token: 't1' };

function player(id: string, score = 0, joinedAt = 0): PlayerView {
  return {
    id,
    name: id.toUpperCase(),
    avatar: 'bolt',
    score,
    connected: true,
    joinedAt,
    stats: { rolls: 0, penalties: 0, bestTurn: 0 },
  };
}

function room(patch: Partial<RoomView> = {}): RoomView {
  return {
    code: SESSION.code,
    hostId: 'p1',
    status: 'lobby',
    phase: 'idle',
    settings: DEFAULT_SETTINGS,
    players: [player('p1', 0, 1), player('p2', 0, 2)],
    turn: null,
    lastRoll: null,
    winner: null,
    round: 0,
    log: [],
    serverTime: 0,
    ...patch,
  };
}

function playing(playerId: string, rolls: number[], phase: RoomView['phase'] = 'idle'): RoomView {
  return room({
    status: 'playing',
    phase,
    round: 1,
    turn: { playerId, number: 1, points: 0, rolls, startedAt: 0 },
  });
}

describe('GameStore', () => {
  let socket: FakeSocket;
  let store: GameStore;

  const joinResult = (r = room()): JoinResult => ({ session: SESSION, room: r });

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    socket = new FakeSocket();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: SocketService, useValue: socket }],
    });
    TestBed.inject(ProfileService).setName('  Stiven  ');
    store = TestBed.inject(GameStore);
  });

  it('crear sala guarda la sesión de la pestaña y el estado', async () => {
    socket.request.mockResolvedValue(joinResult());

    await expect(store.createRoom(DEFAULT_SETTINGS)).resolves.toBe('882109');

    expect(socket.request).toHaveBeenCalledWith('room:create', {
      profile: { name: 'Stiven', avatar: expect.any(String) },
      settings: DEFAULT_SETTINGS,
    });
    expect(store.session()).toEqual(SESSION);
    expect(store.isHost()).toBe(true);
    expect(store.me()?.id).toBe('p1');
    expect(JSON.parse(sessionStorage.getItem('rr.session') ?? 'null')).toEqual(SESSION);
    expect(store.busy()).toBe(false);
  });

  it('ignora estados de otras salas', async () => {
    socket.request.mockResolvedValue(joinResult());
    await store.joinRoom('882109');

    socket.emit('room:state', room({ code: '111111', round: 9 }));
    expect(store.room()?.round).toBe(0);

    socket.emit('room:state', room({ round: 3 }));
    expect(store.room()?.round).toBe(3);
  });

  it('solo el jugador del turno puede lanzar, y plantarse exige un lanzamiento', async () => {
    socket.request.mockResolvedValue(joinResult());
    await store.joinRoom('882109');

    socket.emit('room:state', playing('p1', []));
    expect([store.isMyTurn(), store.canRoll(), store.canPass()]).toEqual([true, true, false]);

    socket.emit('room:state', playing('p1', [4]));
    expect([store.canRoll(), store.canPass()]).toEqual([true, true]);

    socket.emit('room:state', playing('p1', [4], 'rolling'));
    expect([store.canRoll(), store.canPass()]).toEqual([false, false]);

    socket.emit('room:state', playing('p2', [3]));
    expect([store.isMyTurn(), store.canRoll(), store.canPass()]).toEqual([false, false, false]);
    expect(store.currentPlayer()?.id).toBe('p2');
  });

  it('la clasificación ordena por score y desempata por orden de llegada', async () => {
    socket.request.mockResolvedValue(
      joinResult(
        room({ players: [player('p1', 10, 1), player('p2', 25, 2), player('p3', 10, 3)] }),
      ),
    );
    await store.joinRoom('882109');

    expect(store.leaderboard().map((row) => [row.player.id, row.order])).toEqual([
      ['p2', 2],
      ['p1', 1],
      ['p3', 3],
    ]);
  });

  it('muestra el error del servidor en un aviso sin relanzarlo', async () => {
    socket.request.mockResolvedValueOnce(joinResult());
    await store.joinRoom('882109');

    socket.request.mockRejectedValueOnce(new Error('No es tu turno.'));
    await expect(store.roll()).resolves.toBeUndefined();

    expect(socket.request).toHaveBeenLastCalledWith('game:roll', {});
    expect(TestBed.inject(ToastService).toasts().at(-1)?.text).toBe('No es tu turno.');
    expect(store.busy()).toBe(false);
  });

  it('al ser expulsado limpia la sesión y vuelve al inicio', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    socket.request.mockResolvedValue(joinResult());
    await store.joinRoom('882109');

    socket.emit('room:kicked', { reason: 'El anfitrión te expulsó de la sala.' });

    expect(store.session()).toBeNull();
    expect(store.room()).toBeNull();
    expect(sessionStorage.getItem('rr.session')).toBeNull();
    // Reemplaza la entrada: "atrás" no debe volver a una sala de la que ya no forma parte.
    expect(navigate).toHaveBeenCalledWith('/', { replaceUrl: true });
    expect(TestBed.inject(ToastService).toasts().at(-1)?.text).toBe(
      'El anfitrión te expulsó de la sala.',
    );
  });

  it('ensureRoom distingue sala cargada, sin sesión y reconexión fallida', async () => {
    expect(await store.ensureRoom('882109')).toBe('no-session');

    socket.request.mockResolvedValueOnce(joinResult());
    await store.joinRoom('882109');
    expect(await store.ensureRoom('882109')).toBe('ok');
    expect(await store.ensureRoom('123456')).toBe('no-session');

    // Sesión guardada pero el servidor ya no reconoce la silla.
    store.room.set(null);
    socket.request.mockRejectedValueOnce(new ServerError('La sala ya no existe.'));
    expect(await store.ensureRoom('882109')).toBe('failed');
    expect(socket.request).toHaveBeenLastCalledWith('room:rejoin', SESSION);
    expect(store.session()).toBeNull();
    expect(sessionStorage.getItem('rr.session')).toBeNull();
  });

  describe('reconexión a la silla', () => {
    beforeEach(async () => {
      socket.request.mockResolvedValueOnce(joinResult());
      await store.joinRoom('882109');
      // Como tras una recarga: socket nuevo (sin silla) y sin sala en el store.
      socket.goOffline();
      socket.connected = true;
      socket.status.set('online');
      store.room.set(null);
    });

    it('un corte o un timeout conserva la sesión (no es un rechazo)', async () => {
      const navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl');
      socket.request.mockRejectedValueOnce(new TransportError('Sin conexión'));

      expect(await store.ensureRoom('882109')).toBe('pending');

      expect(store.session()).toEqual(SESSION);
      expect(JSON.parse(sessionStorage.getItem('rr.session') ?? 'null')).toEqual(SESSION);
      expect(navigate).not.toHaveBeenCalled();
    });

    it('un error interno del servidor tampoco borra la sesión', async () => {
      socket.request.mockRejectedValueOnce(new ServerError('Error interno del servidor'));
      expect(await store.ensureRoom('882109')).toBe('pending');
      expect(store.session()).toEqual(SESSION);
    });

    it('sin conexión no emite: el rejoin sale al conectar', async () => {
      socket.goOffline();
      socket.request.mockClear();

      expect(await store.ensureRoom('882109')).toBe('pending');
      expect(socket.request).not.toHaveBeenCalled();

      socket.request.mockResolvedValueOnce(joinResult(room({ round: 4 })));
      socket.goOnline();
      await flush();

      expect(socket.request).toHaveBeenCalledWith('room:rejoin', SESSION);
      expect(store.room()?.round).toBe(4);
      expect(await store.ensureRoom('882109')).toBe('ok');
    });

    it('con conexión pero sin respuesta reintenta con espera', async () => {
      vi.useFakeTimers();
      try {
        socket.request.mockRejectedValueOnce(new TransportError('El servidor no respondió.'));
        expect(await store.ensureRoom('882109')).toBe('pending');

        socket.request.mockResolvedValueOnce(joinResult(room({ round: 2 })));
        await vi.advanceTimersByTimeAsync(1000);

        expect(socket.events().filter((e) => e === 'room:rejoin')).toHaveLength(2);
        expect(store.room()?.round).toBe(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('si sale mientras el rejoin está en vuelo, no recupera la silla al llegar la respuesta', async () => {
      let answer!: (value: JoinResult) => void;
      socket.request.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)));
      const ensured = store.ensureRoom('882109');

      socket.request.mockResolvedValue(null);
      await store.leave();
      answer(joinResult());

      expect(await ensured).toBe('pending');
      expect(store.session()).toBeNull();
      expect(sessionStorage.getItem('rr.session')).toBeNull();
    });
  });

  it('las acciones de partida se bloquean sin conexión', async () => {
    socket.request.mockResolvedValue(joinResult());
    await store.joinRoom('882109');
    socket.emit('room:state', playing('p1', [3]));
    expect([store.canRoll(), store.canPass()]).toEqual([true, true]);

    socket.goOffline();
    expect([store.canRoll(), store.canPass()]).toEqual([false, false]);
  });

  it('salir sin conexión libera la silla en cuanto vuelve la conexión', async () => {
    socket.request.mockResolvedValueOnce(joinResult());
    await store.joinRoom('882109');
    socket.goOffline();
    socket.request.mockClear();

    await store.leave();
    expect(store.session()).toBeNull();
    expect(socket.request).not.toHaveBeenCalled();
    expect(JSON.parse(sessionStorage.getItem('rr.pendingLeave') ?? 'null')).toEqual(SESSION);

    socket.request.mockImplementation((event) =>
      Promise.resolve(event === 'room:rejoin' ? joinResult() : null),
    );
    socket.goOnline();
    await flush();

    // rejoin + leave seguidos en el mismo socket, sin volver a ocupar la silla en el cliente.
    expect(socket.request.mock.calls).toEqual([
      ['room:rejoin', SESSION],
      ['room:leave', {}],
    ]);
    expect(store.session()).toBeNull();
    expect(store.room()).toBeNull();
    expect(sessionStorage.getItem('rr.pendingLeave')).toBeNull();
  });

  it('avisa del turno si el jugador está fuera de la pantalla de la sala', async () => {
    socket.request.mockResolvedValue(joinResult());
    await store.joinRoom('882109');
    const toasts = TestBed.inject(ToastService);

    socket.emit('room:state', playing('p1', []));
    TestBed.tick();

    expect(toasts.toasts().at(-1)?.text).toBe('¡Es tu turno en la sala 882 · 109! Vuelve para jugar.');

    // El mismo turno no se anuncia dos veces.
    toasts.toasts.set([]);
    socket.emit('room:state', playing('p1', [4]));
    TestBed.tick();
    expect(toasts.toasts()).toEqual([]);
  });

  it('salir limpia la sesión aunque el servidor no responda', async () => {
    socket.request.mockResolvedValueOnce(joinResult());
    await store.joinRoom('882109');

    socket.request.mockRejectedValueOnce(new TransportError('El servidor no respondió.'));
    socket.request.mockResolvedValue(null);
    await store.leave();

    expect(store.session()).toBeNull();
    expect(store.room()).toBeNull();
    // Sin respuesta no se sabe si salió: se libera la silla de forma segura (rejoin + leave).
    expect(socket.events()).toEqual(['room:join', 'room:leave', 'room:rejoin', 'room:leave']);
  });
});
