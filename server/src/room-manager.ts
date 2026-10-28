import { randomInt } from 'node:crypto';
import { GameRoom, resolveTimings } from './game-room.ts';
import type { Timings } from './game-room.ts';

/** Una sala sin cambios durante este tiempo se elimina aunque haya gente conectada. */
export const INACTIVE_ROOM_TTL_MS = 6 * 60 * 60_000;
export const SWEEP_INTERVAL_MS = 1000;
export const ROOM_CLOSED_REASON = 'La sala se cerró.';

export interface RoomManagerOptions {
  now?: () => number;
  rollDie?: () => number;
  timings?: Partial<Timings>;
  /** Se llama cada vez que cambia el estado visible de una sala. */
  onRoomChange?: (room: GameRoom) => void;
  /** Se llama al eliminar una sala (antes de soltarla) con el motivo para quien siga dentro. */
  onRoomClosed?: (room: GameRoom, reason: string) => void;
  /** `false` desactiva el barrido automático (los tests llaman `sweep()` a mano). */
  autoSweep?: boolean;
  inactiveRoomTtlMs?: number;
  /** Salas activas como máximo (por defecto, sin tope). */
  maxRooms?: number;
}

/** Registro de salas activas en memoria + barrido periódico de reglas por tiempo y limpieza. */
export class RoomManager {
  private readonly rooms = new Map<string, GameRoom>();
  private readonly options: RoomManagerOptions;
  private readonly timings: Timings;
  private readonly now: () => number;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(options: RoomManagerOptions = {}) {
    this.options = options;
    this.timings = resolveTimings(options.timings);
    this.now = options.now ?? Date.now;
    if (options.autoSweep !== false) {
      this.interval = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
      this.interval.unref();
    }
  }

  get size(): number {
    return this.rooms.size;
  }

  /** `true` si ya no se pueden crear más salas. */
  get isFull(): boolean {
    return this.rooms.size >= (this.options.maxRooms ?? Infinity);
  }

  get(code: string): GameRoom | undefined {
    return this.rooms.get(code);
  }

  all(): GameRoom[] {
    return [...this.rooms.values()];
  }

  create(settings: unknown): GameRoom {
    if (this.isFull) {
      throw new Error('Se alcanzó el máximo de salas');
    }
    const room = new GameRoom(this.uniqueCode(), settings, {
      now: this.now,
      rollDie: this.options.rollDie,
      timings: this.timings,
      onChange: (r) => this.options.onRoomChange?.(r),
    });
    this.rooms.set(room.code, room);
    return room;
  }

  /** Elimina la sala si ya no tiene jugadores. Devuelve `true` si la eliminó. */
  removeIfEmpty(room: GameRoom): boolean {
    return room.playerCount === 0 ? this.close(room.code) : false;
  }

  close(code: string, reason: string = ROOM_CLOSED_REASON): boolean {
    const room = this.rooms.get(code);
    if (!room) {
      return false;
    }
    this.rooms.delete(code);
    room.dispose();
    try {
      this.options.onRoomClosed?.(room, reason);
    } catch (err) {
      console.error(`[sala ${code}] error al cerrar`, err);
    }
    return true;
  }

  /** Corre las reglas por tiempo de cada sala y elimina las vacías o abandonadas. */
  sweep(): void {
    const now = this.now();
    for (const room of this.all()) {
      try {
        room.tick();
      } catch (err) {
        console.error(`[sala ${room.code}] error en tick`, err);
      }
      const idleSince = room.idleSince();
      const inactiveTtl = this.options.inactiveRoomTtlMs ?? INACTIVE_ROOM_TTL_MS;
      if (
        room.playerCount === 0 ||
        (idleSince !== null && now - idleSince >= this.timings.emptyRoomTtlMs) ||
        now - room.lastActivityAt >= inactiveTtl
      ) {
        this.close(room.code);
      }
    }
  }

  dispose(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    for (const room of this.rooms.values()) {
      room.dispose();
    }
    this.rooms.clear();
  }

  private uniqueCode(): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      const code = String(randomInt(100000, 1000000));
      if (!this.rooms.has(code)) {
        return code;
      }
    }
    throw new Error('No se pudo generar un código de sala único');
  }
}
