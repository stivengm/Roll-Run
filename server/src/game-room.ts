import { randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { LOG_LIMIT, TIMINGS } from '../../shared/protocol.ts';
import type {
  GamePhase,
  LogEntry,
  LogKind,
  PlayerProfile,
  PlayerStats,
  PlayerView,
  RollView,
  RoomSettings,
  RoomStatus,
  RoomView,
  TurnView,
  WinnerView,
} from '../../shared/protocol.ts';
import { asDieValue, nameKey, sanitizeProfile, sanitizeSettings } from './validation.ts';

export type Timings = { -readonly [K in keyof typeof TIMINGS]: number };

export interface GameRoomDeps {
  now(): number;
  rollDie(): number;
  timings: Timings;
  onChange(room: GameRoom): void;
}

export interface GameRoomOptions {
  now?: () => number;
  rollDie?: () => number;
  timings?: Partial<Timings>;
  onChange?: (room: GameRoom) => void;
}

export type Fail = { ok: false; error: string };
export type Result<T extends object = object> = ({ ok: true } & T) | Fail;

export interface SeatResult {
  playerId: string;
  token: string;
}

export interface RemoveResult {
  playerId: string;
  /** `true` si la sala quedó sin jugadores. */
  empty: boolean;
}

interface PlayerState {
  id: string;
  name: string;
  avatar: string;
  score: number;
  joinedAt: number;
  token: string;
  /** `null` mientras está conectado. */
  disconnectedAt: number | null;
  /** Última vez que pasó a estar conectado. */
  connectedAt: number;
  stats: PlayerStats;
}

/** Plan de `addPlayer`: perfil saneado y, si hace falta, la silla fantasma que se libera. */
interface SeatPlan {
  profile: PlayerProfile;
  release: PlayerState | null;
}

/** Sesión inválida o sala inexistente: el mismo texto para no delatar qué salas existen. */
export const SESSION_EXPIRED = 'La sala ya no existe o tu sesión expiró.';
export const GAME_STARTED = 'La partida ya comenzó. Espera a que termine.';
export const GAME_FINISHED =
  'La partida acaba de terminar. Podrás entrar cuando el anfitrión inicie la revancha.';
const DROPPED_IN_GAME =
  'La partida empezó sin ti mientras estabas desconectado. Podrás volver a entrar en la revancha.';
const DROPPED_IN_LOBBY =
  'Perdiste tu lugar en la sala por estar desconectado. Vuelve a entrar con el código.';
/** Cuántos jugadores retirados por desconexión se recuerdan para explicarles el motivo. */
const DROPPED_MEMORY = 32;

export function defaultRollDie(): number {
  return randomInt(1, 7);
}

/** `TIMINGS` con los overrides válidos (números finitos >= 0) aplicados. */
export function resolveTimings(overrides: Partial<Timings> = {}): Timings {
  const timings: Timings = { ...TIMINGS };
  for (const key of Object.keys(timings) as (keyof Timings)[]) {
    const value = overrides[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      timings[key] = value;
    }
  }
  return timings;
}

function fail(error: string): Fail {
  return { ok: false, error };
}

function emptyStats(): PlayerStats {
  return { rolls: 0, penalties: 0, bestTurn: 0 };
}

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Motor de reglas de una sala. No sabe nada de Socket.IO: recibe acciones, valida y avisa
 * por `onChange` cada vez que su estado visible cambia. Las secuencias con pausa
 * (giro del dado, penitencia, victoria) se programan con un único timer cancelable.
 */
export class GameRoom {
  readonly code: string;
  readonly createdAt: number;
  /** Última vez que el estado cambió (para limpiar salas abandonadas). */
  lastActivityAt: number;

  private readonly deps: GameRoomDeps;
  private settings: RoomSettings;
  private players: PlayerState[] = [];
  private hostId = '';
  private status: RoomStatus = 'lobby';
  private phase: GamePhase = 'idle';
  private turn: TurnView | null = null;
  private lastRoll: RollView | null = null;
  private winner: WinnerView | null = null;
  private round = 0;
  private log: LogEntry[] = [];
  private logSeq = 0;
  private rollSeq = 0;
  private emptySince: number;
  /** Retirados por estar desconectados (id → token), para responderles con el motivo real. */
  private readonly dropped = new Map<string, string>();

  private timer: ReturnType<typeof setTimeout> | null = null;
  /** Se incrementa al programar o cancelar: un callback viejo detecta que ya no aplica. */
  private timerSeq = 0;
  private disposed = false;

  constructor(code: string, settings: unknown, options: GameRoomOptions = {}) {
    this.code = code;
    this.deps = {
      now: options.now ?? Date.now,
      rollDie: options.rollDie ?? defaultRollDie,
      timings: resolveTimings(options.timings),
      onChange: options.onChange ?? (() => {}),
    };
    this.settings = sanitizeSettings(settings);
    this.createdAt = this.now();
    this.lastActivityAt = this.createdAt;
    this.emptySince = this.createdAt;
  }

  // ------------------------------------------------------------------ Consultas

  get playerCount(): number {
    return this.players.length;
  }

  get connectedCount(): number {
    return this.players.filter((p) => p.disconnectedAt === null).length;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  hasPlayer(playerId: string): boolean {
    return this.players.some((p) => p.id === playerId);
  }

  /** Token vigente del jugador (para devolverle su sesión). */
  tokenOf(playerId: string): string | null {
    return this.find(playerId)?.token ?? null;
  }

  /** Desde cuándo no hay nadie conectado, o `null` si hay alguien conectado. */
  idleSince(): number | null {
    if (this.players.length === 0) {
      return this.emptySince;
    }
    let latest = 0;
    for (const p of this.players) {
      if (p.disconnectedAt === null) {
        return null;
      }
      latest = Math.max(latest, p.disconnectedAt);
    }
    return latest;
  }

  view(): RoomView {
    return {
      code: this.code,
      hostId: this.hostId,
      status: this.status,
      phase: this.phase,
      settings: { ...this.settings },
      players: this.players.map(
        (p): PlayerView => ({
          id: p.id,
          name: p.name,
          avatar: p.avatar,
          score: p.score,
          connected: p.disconnectedAt === null,
          joinedAt: p.joinedAt,
          stats: { ...p.stats },
        }),
      ),
      turn: this.turn ? { ...this.turn, rolls: [...this.turn.rolls] } : null,
      lastRoll: this.lastRoll ? { ...this.lastRoll } : null,
      winner: this.winner ? { ...this.winner } : null,
      round: this.round,
      log: this.log.map((entry) => ({ ...entry })),
      serverTime: this.now(),
    };
  }

  // ------------------------------------------------------------------ Jugadores

  /** Validación previa de `addPlayer` (sin efectos), útil antes de abandonar otra sala. */
  canAddPlayer(profile: unknown): Fail | null {
    const plan = this.planSeat(profile);
    return 'error' in plan ? plan : null;
  }

  addPlayer(profile: unknown): Result<SeatResult> {
    const plan = this.planSeat(profile);
    if ('error' in plan) {
      return plan;
    }
    if (plan.release) {
      this.dropOffline(plan.release);
    }
    const now = this.now();
    const lastJoin = this.players.at(-1)?.joinedAt ?? 0;
    const player: PlayerState = {
      id: randomUUID(),
      name: plan.profile.name,
      avatar: plan.profile.avatar,
      score: 0,
      // Estrictamente creciente aunque dos jugadores entren en el mismo milisegundo.
      joinedAt: Math.max(now, lastJoin + 1),
      token: randomBytes(16).toString('hex'),
      disconnectedAt: null,
      connectedAt: now,
      stats: emptyStats(),
    };
    this.players.push(player);
    if (!this.hostId) {
      this.hostId = player.id;
    }
    this.addLog('join', `${player.name} entró a la sala`, player.id);
    this.changed();
    return { ok: true, playerId: player.id, token: player.token };
  }

  removePlayer(playerId: string, reason: 'leave' | 'kick', byId?: string): Result<RemoveResult> {
    const player = this.find(playerId);
    if (!player) {
      return fail('Ese jugador ya no está en la sala.');
    }
    if (reason === 'kick') {
      if (byId !== this.hostId) {
        return fail('Solo el anfitrión puede expulsar jugadores.');
      }
      if (byId === playerId) {
        return fail('No puedes expulsarte a ti mismo.');
      }
    }
    const text =
      reason === 'kick'
        ? `${player.name} fue expulsado por el anfitrión`
        : `${player.name} salió de la sala`;
    this.detach(player, reason, text);
    this.changed();
    return { ok: true, playerId, empty: this.players.length === 0 };
  }

  rejoin(playerId: string, token: string): Result<SeatResult> {
    if (typeof token !== 'string') {
      return fail(SESSION_EXPIRED);
    }
    const player = this.find(playerId);
    if (!player) {
      const dropped = this.dropped.get(playerId);
      const wasDropped = dropped !== undefined && sameToken(dropped, token);
      return fail(wasDropped ? this.droppedReason() : SESSION_EXPIRED);
    }
    if (!sameToken(player.token, token)) {
      return fail(SESSION_EXPIRED);
    }
    // Solo se avisa si de verdad volvió: un rejoin repetido no inunda la sala con estados.
    this.markConnected(player, true);
    return { ok: true, playerId: player.id, token: player.token };
  }

  setConnected(playerId: string, connected: boolean): Result {
    const player = this.find(playerId);
    if (!player) {
      return fail('Ese jugador ya no está en la sala.');
    }
    this.markConnected(player, connected);
    return { ok: true };
  }

  // ------------------------------------------------------------------ Lobby

  updateSettings(byId: string, raw: unknown): Result {
    if (byId !== this.hostId) {
      return fail('Solo el anfitrión puede cambiar las reglas.');
    }
    if (this.status !== 'lobby') {
      return fail('Solo puedes cambiar las reglas en el lobby.');
    }
    const next = sanitizeSettings(raw);
    if (next.maxPlayers < this.players.length) {
      return fail('Hay más jugadores en la sala que ese cupo.');
    }
    const prev = this.settings;
    if (
      prev.targetScore === next.targetScore &&
      prev.penaltyNumber === next.penaltyNumber &&
      prev.penaltyMode === next.penaltyMode &&
      prev.maxPlayers === next.maxPlayers
    ) {
      return { ok: true };
    }
    this.settings = next;
    const mode = next.penaltyMode === 'all' ? 'pierde todo' : 'solo el turno';
    const text =
      `Reglas: meta ${next.targetScore} · penitencia ${next.penaltyNumber} (${mode})` +
      ` · cupo ${next.maxPlayers}`;
    this.addLog('settings', text, byId);
    this.changed();
    return { ok: true };
  }

  start(byId: string): Result {
    if (byId !== this.hostId) {
      return fail('Solo el anfitrión puede iniciar la partida.');
    }
    if (this.status !== 'lobby') {
      return fail(
        this.status === 'playing'
          ? 'La partida ya comenzó.'
          : 'Vuelve al lobby para iniciar otra partida.',
      );
    }
    if (this.connectedCount < 2) {
      return fail('Se necesitan al menos 2 jugadores conectados.');
    }
    // Quien se desconectó hace poco (recarga, cambio de app) juega: si no vuelve, su turno se
    // salta solo. Quien lleva mucho fuera queda fuera de la partida.
    for (const p of this.players.filter((pl) => this.isStale(pl))) {
      this.dropOffline(p);
    }
    this.resetScores();
    this.round++;
    this.status = 'playing';
    this.phase = 'idle';
    this.lastRoll = null;
    this.winner = null;
    const first = this.players[0];
    this.turn = { playerId: first.id, number: 1, points: 0, rolls: [], startedAt: this.now() };
    this.addLog('start', `¡Comienza la partida #${this.round}! Empieza ${first.name}`, first.id);
    this.changed();
    return { ok: true };
  }

  restart(byId: string): Result {
    if (byId !== this.hostId) {
      return fail('Solo el anfitrión puede iniciar la revancha.');
    }
    if (this.status !== 'finished') {
      return fail('La partida aún no ha terminado.');
    }
    this.backToLobby();
    this.addLog('reset', 'Revancha: todos vuelven a 0');
    this.changed();
    return { ok: true };
  }

  // ------------------------------------------------------------------ Partida

  roll(byId: string): Result<{ rollId: number }> {
    const check = this.checkTurn(byId);
    if (check) {
      return check;
    }
    const player = this.currentPlayer()!;
    const rollId = ++this.rollSeq;
    this.phase = 'rolling';
    this.lastRoll = {
      id: rollId,
      playerId: player.id,
      value: null,
      isPenalty: false,
      lostPoints: 0,
      scoreAfter: player.score,
    };
    this.changed();
    this.schedule(this.deps.timings.rollMs, () => this.reveal(rollId));
    return { ok: true, rollId };
  }

  pass(byId: string): Result {
    const check = this.checkTurn(byId);
    if (check) {
      return check;
    }
    const turn = this.turn!;
    if (turn.rolls.length < 1) {
      return fail('Lanza el dado al menos una vez antes de pasar.');
    }
    const player = this.currentPlayer()!;
    this.addLog(
      'pass',
      `${player.name} se plantó con ${player.score} pts (+${turn.points} este turno)`,
      player.id,
      turn.points,
    );
    this.advanceTurn();
    this.changed();
    return { ok: true };
  }

  skip(byId: string): Result {
    if (byId !== this.hostId) {
      return fail('Solo el anfitrión puede saltar turnos.');
    }
    if (this.status !== 'playing' || !this.turn) {
      return fail('La partida no está en curso.');
    }
    if (this.phase !== 'idle') {
      return fail('Espera a que termine el lanzamiento.');
    }
    const player = this.currentPlayer();
    if (!player || player.disconnectedAt === null) {
      return fail('Solo puedes saltar el turno de un jugador desconectado.');
    }
    this.addLog('skip', `El anfitrión saltó el turno de ${player.name}`, player.id);
    this.advanceTurn();
    this.changed();
    return { ok: true };
  }

  /** Reglas por tiempo. La llama el `RoomManager` cada segundo. */
  tick(): void {
    if (this.disposed) {
      return;
    }
    const now = this.now();
    const { disconnectedTurnSkipMs, hostTransferMs } = this.deps.timings;
    let dirty = false;

    // 1) Turno de un jugador desconectado: se salta solo.
    const current = this.currentPlayer();
    if (
      this.status === 'playing' &&
      this.phase === 'idle' &&
      current &&
      current.disconnectedAt !== null &&
      now - Math.max(this.turn!.startedAt, current.disconnectedAt) >= disconnectedTurnSkipMs &&
      this.players.some((p) => p !== current && p.disconnectedAt === null)
    ) {
      this.addLog('skip', `Se saltó el turno de ${current.name} (desconectado)`, current.id);
      this.advanceTurn();
      dirty = true;
    }

    // 2) Anfitrión ausente demasiado tiempo mientras otro esperaba: el rol pasa al primer
    // conectado. Solo cuenta el tiempo con alguien más en línea (si estaba solo, no hay prisa).
    const host = this.find(this.hostId);
    const online = this.players.filter((p) => p.disconnectedAt === null);
    if (host && host.disconnectedAt !== null && online.length > 0) {
      const watchedSince = Math.min(...online.map((p) => p.connectedAt));
      if (now - Math.max(host.disconnectedAt, watchedSince) >= hostTransferMs) {
        this.setHost(online[0]);
        dirty = true;
      }
    }

    // 3) En el lobby nadie sale por tiempo: las sillas fantasma se liberan solo cuando hacen
    // falta (sala llena, alguien entra con su apodo o empieza la partida) y la sala sin nadie
    // conectado la cierra el `RoomManager` tras `emptyRoomTtlMs`.
    if (dirty) {
      this.changed();
    }
  }

  /** Cancela timers pendientes. La sala deja de emitir cambios. */
  dispose(): void {
    this.cancelTimer();
    this.disposed = true;
  }

  // ------------------------------------------------------------------ Internos

  private now(): number {
    return this.deps.now();
  }

  private find(playerId: string): PlayerState | undefined {
    return this.players.find((p) => p.id === playerId);
  }

  private currentPlayer(): PlayerState | undefined {
    return this.turn ? this.find(this.turn.playerId) : undefined;
  }

  /** Desconectado hace al menos `lobbyDisconnectRemoveMs`: su silla se puede liberar. */
  private isStale(player: PlayerState): boolean {
    return (
      player.disconnectedAt !== null &&
      this.now() - player.disconnectedAt >= this.deps.timings.lobbyDisconnectRemoveMs
    );
  }

  /** Decide si cabe un jugador nuevo y qué silla fantasma habría que liberar (sin efectos). */
  private planSeat(raw: unknown): SeatPlan | Fail {
    if (this.status === 'finished' || this.phase === 'won') {
      return fail(GAME_FINISHED);
    }
    if (this.status !== 'lobby') {
      return fail(GAME_STARTED);
    }
    const clean = sanitizeProfile(raw);
    if (!clean.ok) {
      return clean;
    }
    const key = nameKey(clean.value.name);
    const namesake = this.players.find((p) => nameKey(p.name) === key);
    if (namesake && !this.isStale(namesake)) {
      return fail('Ese apodo ya está en uso en esta sala.');
    }
    // Si alguien vuelve con el apodo de una silla fantasma, esa silla se libera.
    let release = namesake ?? null;
    if (!release && this.players.length >= this.settings.maxPlayers) {
      const ghosts = this.players.filter((p) => this.isStale(p));
      ghosts.sort((a, b) => a.disconnectedAt! - b.disconnectedAt!);
      release = ghosts[0] ?? null;
      if (!release) {
        return fail('La sala está llena.');
      }
    }
    return { profile: clean.value, release };
  }

  private markConnected(player: PlayerState, connected: boolean): void {
    if ((player.disconnectedAt === null) === connected) {
      return;
    }
    const now = this.now();
    if (connected) {
      player.disconnectedAt = null;
      player.connectedAt = now;
    } else {
      player.disconnectedAt = now;
    }
    this.changed();
  }

  /** Saca a un jugador por estar desconectado y lo recuerda para explicarle el motivo. */
  private dropOffline(player: PlayerState): void {
    this.dropped.delete(player.id);
    this.dropped.set(player.id, player.token);
    if (this.dropped.size > DROPPED_MEMORY) {
      const oldest = this.dropped.keys().next().value;
      if (oldest !== undefined) {
        this.dropped.delete(oldest);
      }
    }
    this.detach(player, 'leave', `${player.name} salió de la sala (sin conexión)`);
  }

  private droppedReason(): string {
    return this.status === 'lobby' ? DROPPED_IN_LOBBY : DROPPED_IN_GAME;
  }

  /** Validaciones comunes de lanzar / plantarse. */
  private checkTurn(byId: string): Fail | null {
    if (this.status !== 'playing' || !this.turn) {
      return fail('La partida no está en curso.');
    }
    if (this.turn.playerId !== byId) {
      return fail('No es tu turno.');
    }
    if (this.phase !== 'idle') {
      return fail('Espera a que termine el lanzamiento.');
    }
    return this.currentPlayer() ? null : fail('No es tu turno.');
  }

  private drawDie(): number {
    let value: number | null = null;
    try {
      value = asDieValue(this.deps.rollDie());
    } catch {
      value = null;
    }
    return value ?? defaultRollDie();
  }

  private reveal(rollId: number): void {
    const player = this.currentPlayer();
    const turn = this.turn;
    if (
      !player ||
      !turn ||
      this.status !== 'playing' ||
      this.phase !== 'rolling' ||
      this.lastRoll?.id !== rollId
    ) {
      return;
    }
    const value = this.drawDie();
    turn.rolls.push(value);
    player.stats.rolls++;

    if (value === this.settings.penaltyNumber) {
      const lost =
        this.settings.penaltyMode === 'all' ? player.score : Math.min(turn.points, player.score);
      player.score -= lost;
      player.stats.penalties++;
      this.lastRoll = {
        id: rollId,
        playerId: player.id,
        value,
        isPenalty: true,
        lostPoints: lost,
        scoreAfter: player.score,
      };
      this.phase = 'penalty';
      const suffix = this.settings.penaltyMode === 'all' ? ' · vuelve a 0' : '';
      this.addLog(
        'penalty',
        `¡Penitencia! ${player.name} sacó ${value} y perdió ${lost} pts${suffix}`,
        player.id,
        value,
      );
      this.changed();
      this.schedule(this.deps.timings.penaltyMs, () => {
        if (this.status === 'playing' && this.phase === 'penalty' && this.turn === turn) {
          this.advanceTurn();
          this.changed();
        }
      });
      return;
    }

    player.score += value;
    turn.points += value;
    player.stats.bestTurn = Math.max(player.stats.bestTurn, turn.points);
    this.lastRoll = {
      id: rollId,
      playerId: player.id,
      value,
      isPenalty: false,
      lostPoints: 0,
      scoreAfter: player.score,
    };
    this.addLog(
      'roll',
      `${player.name} sacó ${value} (+${value} · total ${player.score})`,
      player.id,
      value,
    );

    if (player.score >= this.settings.targetScore) {
      this.phase = 'won';
      this.winner = {
        id: player.id,
        name: player.name,
        avatar: player.avatar,
        score: player.score,
      };
      this.addLog(
        'win',
        `¡${player.name} llegó a ${player.score} pts y gana la partida!`,
        player.id,
        player.score,
      );
      this.changed();
      this.schedule(this.deps.timings.winMs, () => {
        if (this.status === 'playing' && this.phase === 'won') {
          this.status = 'finished';
          this.phase = 'idle';
          this.changed();
        }
      });
      return;
    }

    this.phase = 'idle';
    this.changed();
  }

  private advanceTurn(): void {
    if (!this.turn || this.players.length === 0) {
      return;
    }
    const index = this.players.findIndex((p) => p.id === this.turn!.playerId);
    const next = this.players[(index + 1) % this.players.length];
    this.beginTurn(next.id);
  }

  private beginTurn(playerId: string): void {
    this.cancelTimer();
    this.turn = {
      playerId,
      number: (this.turn?.number ?? 0) + 1,
      points: 0,
      rolls: [],
      startedAt: this.now(),
    };
    this.phase = 'idle';
  }

  /**
   * Saca a un jugador (sin emitir): reasigna anfitrión, mantiene coherente el turno y
   * cancela la partida si ya no hay rivales.
   */
  private detach(player: PlayerState, kind: 'leave' | 'kick', text: string): void {
    const index = this.players.indexOf(player);
    if (index < 0) {
      return;
    }
    const wasTurn = this.status === 'playing' && this.turn?.playerId === player.id;
    // El turno pasa a quien iba después de él: se calcula antes de quitarlo.
    const after = this.players.length > 1 ? this.players[(index + 1) % this.players.length] : null;

    this.players.splice(index, 1);
    this.addLog(kind, text, player.id);
    if (this.players.length === 0) {
      this.emptySince = this.now();
    }

    if (this.hostId === player.id) {
      const heir = this.players.find((p) => p.disconnectedAt === null) ?? this.players[0];
      if (heir) {
        this.setHost(heir);
      } else {
        this.hostId = '';
      }
    }

    if (this.status !== 'playing' || this.phase === 'won') {
      // En 'won' el winner es una instantánea: el timer termina la partida igual.
      return;
    }
    if (this.players.length < 2) {
      this.backToLobby();
      this.addLog('cancel', 'Partida cancelada: no hay suficientes jugadores');
      return;
    }
    if (wasTurn && after) {
      if (this.lastRoll?.value === null) {
        // Lanzamiento sin revelar del jugador que se fue: se descarta.
        this.lastRoll = null;
      }
      this.beginTurn(after.id);
    }
  }

  private setHost(player: PlayerState): void {
    if (this.hostId === player.id) {
      return;
    }
    this.hostId = player.id;
    this.addLog('host', `Ahora ${player.name} es el anfitrión`, player.id);
  }

  private resetScores(): void {
    for (const p of this.players) {
      p.score = 0;
      p.stats = emptyStats();
    }
  }

  private backToLobby(): void {
    this.cancelTimer();
    this.status = 'lobby';
    this.phase = 'idle';
    this.turn = null;
    this.lastRoll = null;
    this.winner = null;
    this.resetScores();
  }

  private addLog(kind: LogKind, text: string, playerId?: string, value?: number): void {
    const entry: LogEntry = { id: ++this.logSeq, at: this.now(), kind, text };
    if (playerId !== undefined) {
      entry.playerId = playerId;
    }
    if (value !== undefined) {
      entry.value = value;
    }
    this.log.push(entry);
    if (this.log.length > LOG_LIMIT) {
      this.log.splice(0, this.log.length - LOG_LIMIT);
    }
  }

  private schedule(ms: number, fn: () => void): void {
    this.cancelTimer();
    const seq = this.timerSeq;
    this.timer = setTimeout(() => {
      if (this.disposed || seq !== this.timerSeq) {
        return;
      }
      this.timer = null;
      try {
        fn();
      } catch (err) {
        console.error(`[sala ${this.code}] error en secuencia programada`, err);
      }
    }, ms);
  }

  private cancelTimer(): void {
    this.timerSeq++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private changed(): void {
    this.lastActivityAt = this.now();
    if (this.disposed) {
      return;
    }
    try {
      this.deps.onChange(this);
    } catch (err) {
      console.error(`[sala ${this.code}] error al notificar cambios`, err);
    }
  }
}
