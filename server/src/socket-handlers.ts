import type { Server, Socket } from 'socket.io';
import type {
  Ack,
  AckFn,
  ClientToServerEvents,
  JoinResult,
  ServerToClientEvents,
} from '../../shared/protocol.ts';
import { SESSION_EXPIRED } from './game-room.ts';
import type { GameRoom, Result, SeatResult } from './game-room.ts';
import {
  FailureLimiter,
  KeyedRateLimiter,
  TokenBucket,
  clientKey,
  resolveLimits,
} from './limits.ts';
import type { ServerLimits } from './limits.ts';
import type { RoomManager } from './room-manager.ts';
import {
  isId,
  isPlainObject,
  isRoomCode,
  parseSession,
  sanitizeProfile,
  sanitizeSettings,
} from './validation.ts';

export interface SocketData {
  code: string | null;
  playerId: string | null;
  /** Clave del cliente para los límites por IP. */
  ip: string;
}

type InterServerEvents = Record<string, never>;
export type GameIO = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;
export type GameSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

type EventName = keyof ClientToServerEvents;
type AckDataOf<E extends EventName> =
  Parameters<ClientToServerEvents[E]>[1] extends AckFn<infer T> ? T : never;
type Handler<E extends EventName> = (
  socket: GameSocket,
  payload: Record<string, unknown>,
) => Ack<AckDataOf<E>>;

export interface SocketHandlersOptions {
  limits?: Partial<ServerLimits>;
  now?: () => number;
}

export interface SocketHandlers {
  /** Emite `room:state` a toda la sala. Se conecta al `onChange` de cada `GameRoom`. */
  broadcast(room: GameRoom): void;
  /** Avisa con `room:kicked` a quien siga dentro de una sala que se elimina. */
  roomClosed(room: GameRoom, reason: string): void;
}

export const INTERNAL_ERROR = 'Error interno del servidor';
export const KICKED_REASON = 'El anfitrión te expulsó de la sala.';
export const REPLACED_REASON = 'Abriste esta sala en otra pestaña.';
export const TOO_FAST = 'Vas muy rápido. Espera un momento.';
export const TOO_MANY_JOIN_ATTEMPTS =
  'Demasiados intentos. Espera un momento e inténtalo de nuevo.';
export const TOO_MANY_ROOMS = 'Creaste muchas salas seguidas. Espera un momento.';
export const SERVER_FULL = 'El servidor está lleno. Inténtalo de nuevo en unos minutos.';
const NOT_IN_ROOM = 'No estás en ninguna sala.';

function ok(): Ack;
function ok<T>(data: T): Ack<T>;
function ok(data: unknown = null): Ack<unknown> {
  return { ok: true, data };
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

function toAck(result: Result): Ack {
  return result.ok ? ok() : fail(result.error);
}

function joinResult(room: GameRoom, seat: SeatResult): JoinResult {
  return {
    session: { code: room.code, playerId: seat.playerId, token: seat.token },
    room: room.view(),
  };
}

/** Acepta "882 · 109", "882-109" o "882109". */
function normalizeCode(raw: unknown): unknown {
  return typeof raw === 'string' ? raw.replace(/[\s·.-]/g, '') : raw;
}

/**
 * Registra un evento con ack: payload validado, errores atrapados, respuesta única y un tope de
 * eventos por socket (`allow`).
 */
function handle<E extends EventName>(
  socket: GameSocket,
  event: E,
  handler: Handler<E>,
  allow: () => boolean,
): void {
  const listener = (rawPayload: unknown, rawAck: unknown): void => {
    let payload = rawPayload;
    let ack = rawAck;
    // Tolerar emit(evento, ack) sin payload.
    if (typeof ack !== 'function' && typeof payload === 'function') {
      ack = payload;
      payload = undefined;
    }
    if (typeof ack !== 'function') {
      return;
    }
    let response: Ack<unknown>;
    if (!allow()) {
      response = fail(TOO_FAST);
    } else {
      try {
        response = handler(socket, isPlainObject(payload) ? payload : {});
      } catch (err) {
        console.error(`[socket ${socket.id}] error en "${event}"`, err);
        response = fail(INTERNAL_ERROR);
      }
    }
    try {
      (ack as (response: Ack<unknown>) => void)(response);
    } catch (err) {
      console.error(`[socket ${socket.id}] error al responder "${event}"`, err);
    }
  };
  socket.on(event, listener as never);
}

export function registerSocketHandlers(
  io: GameIO,
  manager: RoomManager,
  options: SocketHandlersOptions = {},
): SocketHandlers {
  const limits = resolveLimits(options.limits);
  const now = options.now ?? Date.now;
  /** Socket vigente de cada jugador: tras recargar, la desconexión del socket viejo no cuenta. */
  const playerSockets = new Map<string, string>();
  /** Códigos inexistentes por IP: frena a quien intenta adivinar códigos de sala. */
  const joinFailures = new FailureLimiter(
    {
      maxFailures: limits.joinFailures,
      windowMs: limits.joinFailureWindowMs,
      blockMs: limits.joinBlockMs,
      maxBlockMs: limits.joinMaxBlockMs,
    },
    now,
  );
  const roomCreates = new KeyedRateLimiter(
    limits.roomCreateBurst,
    limits.roomCreatesPerMinute / 60,
    now,
  );

  function socketOf(playerId: string): GameSocket | undefined {
    const socketId = playerSockets.get(playerId);
    return socketId ? io.sockets.sockets.get(socketId) : undefined;
  }

  function unbind(socket: GameSocket): void {
    const { code, playerId } = socket.data;
    if (code) {
      void socket.leave(code);
    }
    if (playerId && playerSockets.get(playerId) === socket.id) {
      playerSockets.delete(playerId);
    }
    socket.data.code = null;
    socket.data.playerId = null;
  }

  function bind(socket: GameSocket, room: GameRoom, playerId: string): void {
    const previous = socketOf(playerId);
    if (previous && previous.id !== socket.id) {
      // La misma silla abierta desde otro socket (p. ej. pestaña duplicada): manda el nuevo.
      unbind(previous);
      previous.emit('room:kicked', { reason: REPLACED_REASON });
    }
    socket.data.code = room.code;
    socket.data.playerId = playerId;
    playerSockets.set(playerId, socket.id);
    void socket.join(room.code);
  }

  /** Silla actual del socket si sigue siendo válida; si no, lo desliga. */
  function seatOf(socket: GameSocket): { room: GameRoom; playerId: string } | null {
    const { code, playerId } = socket.data;
    if (!code || !playerId) {
      return null;
    }
    const room = manager.get(code);
    if (!room || !room.hasPlayer(playerId) || playerSockets.get(playerId) !== socket.id) {
      unbind(socket);
      return null;
    }
    return { room, playerId };
  }

  function leaveCurrent(socket: GameSocket): void {
    const seat = seatOf(socket);
    if (!seat) {
      return;
    }
    unbind(socket);
    seat.room.removePlayer(seat.playerId, 'leave');
    manager.removeIfEmpty(seat.room);
  }

  /** Atajo para eventos que actúan sobre la sala del socket. */
  function withSeat(
    socket: GameSocket,
    action: (room: GameRoom, playerId: string) => Result,
  ): Ack {
    const seat = seatOf(socket);
    return seat ? toAck(action(seat.room, seat.playerId)) : fail(NOT_IN_ROOM);
  }

  io.on('connection', (socket) => {
    socket.data = {
      code: null,
      playerId: null,
      ip: clientKey(
        socket.handshake.address,
        socket.handshake.headers['x-forwarded-for'],
        limits.trustProxyHops,
      ),
    };
    const events = new TokenBucket(limits.eventBurst, limits.eventsPerSecond, now());
    const on = <E extends EventName>(event: E, handler: Handler<E>): void =>
      handle(socket, event, handler, () => events.take(now()));

    on('room:create', (s, payload) => {
      const profile = sanitizeProfile(payload['profile']);
      if (!profile.ok) {
        return profile;
      }
      if (manager.isFull) {
        return fail(SERVER_FULL);
      }
      if (!roomCreates.take(s.data.ip)) {
        return fail(TOO_MANY_ROOMS);
      }
      const settings = sanitizeSettings(payload['settings']);
      leaveCurrent(s);
      const room = manager.create(settings);
      const seat = room.addPlayer(profile.value);
      if (!seat.ok) {
        manager.close(room.code);
        return seat;
      }
      bind(s, room, seat.playerId);
      return ok(joinResult(room, seat));
    });

    on('room:join', (s, payload) => {
      // Si la IP está bloqueada se rechaza antes de buscar, para no delatar qué salas existen.
      if (joinFailures.isBlocked(s.data.ip)) {
        return fail(TOO_MANY_JOIN_ATTEMPTS);
      }
      const code = normalizeCode(payload['code']);
      if (!isRoomCode(code)) {
        return fail('El código de sala debe tener 6 dígitos.');
      }
      const profile = sanitizeProfile(payload['profile']);
      if (!profile.ok) {
        return profile;
      }
      const room = manager.get(code);
      if (!room) {
        joinFailures.fail(s.data.ip);
        return fail('No encontramos esa sala. Revisa el código.');
      }
      const current = seatOf(s);
      if (current?.room === room) {
        const token = room.tokenOf(current.playerId);
        if (token) {
          return ok(joinResult(room, { playerId: current.playerId, token }));
        }
      }
      // Validar antes de abandonar la sala actual, para no perder la silla si falla.
      const blocked = room.canAddPlayer(profile.value);
      if (blocked) {
        return blocked;
      }
      leaveCurrent(s);
      const seat = room.addPlayer(profile.value);
      if (!seat.ok) {
        return seat;
      }
      bind(s, room, seat.playerId);
      return ok(joinResult(room, seat));
    });

    on('room:rejoin', (s, payload) => {
      const session = parseSession(payload);
      // Mismo texto si la sala no existe o la sesión no vale: el rejoin no sirve para buscar salas.
      const room = session ? manager.get(session.code) : undefined;
      if (!session || !room) {
        return fail(SESSION_EXPIRED);
      }
      const seat = room.rejoin(session.playerId, session.token);
      if (!seat.ok) {
        return seat;
      }
      const current = seatOf(s);
      if (current && current.playerId !== seat.playerId) {
        leaveCurrent(s);
      }
      bind(s, room, seat.playerId);
      return ok(joinResult(room, seat));
    });

    on('room:leave', (s) => {
      leaveCurrent(s);
      return ok();
    });

    on('room:kick', (s, payload) => {
      const seat = seatOf(s);
      if (!seat) {
        return fail(NOT_IN_ROOM);
      }
      const targetId = payload['playerId'];
      if (!isId(targetId)) {
        return fail('Jugador inválido.');
      }
      const { room } = seat;
      const candidate = socketOf(targetId);
      const target =
        candidate?.data.code === room.code && candidate.data.playerId === targetId
          ? candidate
          : undefined;
      // Se saca del canal antes para que no reciba el estado de una sala en la que ya no está.
      if (target) {
        void target.leave(room.code);
      }
      const result = room.removePlayer(targetId, 'kick', seat.playerId);
      if (!result.ok) {
        if (target) {
          void target.join(room.code);
        }
        return result;
      }
      if (target) {
        unbind(target);
        target.emit('room:kicked', { reason: KICKED_REASON });
      }
      playerSockets.delete(targetId);
      manager.removeIfEmpty(room);
      return ok();
    });

    on('room:settings', (s, payload) =>
      withSeat(s, (room, playerId) => room.updateSettings(playerId, payload['settings'])),
    );

    on('game:start', (s) => withSeat(s, (room, playerId) => room.start(playerId)));
    // Ack inmediato: el resultado del dado llega después por `room:state`.
    on('game:roll', (s) => withSeat(s, (room, playerId) => room.roll(playerId)));
    on('game:pass', (s) => withSeat(s, (room, playerId) => room.pass(playerId)));
    on('game:skip', (s) => withSeat(s, (room, playerId) => room.skip(playerId)));
    on('game:restart', (s) => withSeat(s, (room, playerId) => room.restart(playerId)));

    socket.on('disconnect', () => {
      const { code, playerId } = socket.data;
      if (!code || !playerId || playerSockets.get(playerId) !== socket.id) {
        return;
      }
      playerSockets.delete(playerId);
      try {
        manager.get(code)?.setConnected(playerId, false);
      } catch (err) {
        console.error(`[socket ${socket.id}] error al desconectar`, err);
      }
    });
  });

  return {
    broadcast(room) {
      io.to(room.code).emit('room:state', room.view());
    },
    roomClosed(room, reason) {
      const socketIds = [...(io.sockets.adapter.rooms.get(room.code) ?? [])];
      for (const socketId of socketIds) {
        const socket = io.sockets.sockets.get(socketId);
        if (socket) {
          unbind(socket);
          socket.emit('room:kicked', { reason });
        }
      }
    },
  };
}
