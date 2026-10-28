import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TIMINGS } from '../../shared/protocol.ts';
import type { GameRoom } from '../src/game-room.ts';
import { INACTIVE_ROOM_TTL_MS, RoomManager } from '../src/room-manager.ts';

const TTL = 5_000;

function setup() {
  const closed: { code: string; reason: string }[] = [];
  const changed: string[] = [];
  const manager = new RoomManager({
    now: () => Date.now(),
    timings: { emptyRoomTtlMs: TTL },
    onRoomChange: (room) => changed.push(room.code),
    onRoomClosed: (room, reason) => closed.push({ code: room.code, reason }),
    autoSweep: false,
  });
  return { manager, closed, changed };
}

function seat(room: GameRoom, name: string): string {
  const result = room.addPlayer({ name, avatar: 'bolt' });
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.playerId;
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RoomManager', () => {
  it('crea salas con códigos únicos de 6 dígitos y propaga onChange', () => {
    const { manager, changed } = setup();
    const codes = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const room = manager.create({});
      expect(room.code).toMatch(/^[1-9]\d{5}$/);
      codes.add(room.code);
      seat(room, 'Ana');
    }
    expect(codes.size).toBe(50);
    expect(manager.size).toBe(50);
    expect(changed).toHaveLength(50);
    manager.dispose();
    expect(manager.size).toBe(0);
  });

  it('elimina de inmediato una sala vacía', () => {
    const { manager, closed } = setup();
    const room = manager.create({});
    const id = seat(room, 'Ana');
    expect(manager.removeIfEmpty(room)).toBe(false);
    room.removePlayer(id, 'leave');
    expect(manager.removeIfEmpty(room)).toBe(true);
    expect(manager.get(room.code)).toBeUndefined();
    expect(closed).toEqual([{ code: room.code, reason: 'La sala se cerró.' }]);
    expect(room.isDisposed).toBe(true);
  });

  it('elimina salas con todos desconectados tras emptyRoomTtlMs', () => {
    const { manager, closed } = setup();
    const room = manager.create({});
    const a = seat(room, 'Ana');
    const b = seat(room, 'Bea');
    room.setConnected(a, false);
    vi.advanceTimersByTime(TTL);
    manager.sweep();
    expect(manager.size).toBe(1);

    room.setConnected(b, false);
    vi.advanceTimersByTime(TTL - 1);
    manager.sweep();
    expect(manager.size).toBe(1);
    vi.advanceTimersByTime(1);
    manager.sweep();
    expect(manager.size).toBe(0);
    expect(closed).toHaveLength(1);
  });

  it('elimina salas sin actividad por más de 6 h', () => {
    const { manager } = setup();
    const room = manager.create({});
    seat(room, 'Ana');
    vi.advanceTimersByTime(INACTIVE_ROOM_TTL_MS - 1);
    manager.sweep();
    expect(manager.size).toBe(1);
    vi.advanceTimersByTime(1);
    manager.sweep();
    expect(manager.size).toBe(0);
  });

  it('el lobby de un anfitrión solo y desconectado no se cierra al minuto', () => {
    const manager = new RoomManager({ now: () => Date.now(), autoSweep: false });
    const room = manager.create({});
    const seatResult = room.addPlayer({ name: 'Ana', avatar: 'bolt' });
    if (!seatResult.ok) {
      throw new Error(seatResult.error);
    }
    // Se fue a compartir el enlace y el móvil congeló la pestaña.
    room.setConnected(seatResult.playerId, false);
    const sweepFor = (ms: number) => {
      for (let t = 0; t < ms; t += 1000) {
        vi.advanceTimersByTime(1000);
        manager.sweep();
      }
    };
    sweepFor(TIMINGS.lobbyDisconnectRemoveMs + 60_000);
    expect(manager.get(room.code)).toBe(room);
    expect(room.view().players.map((p) => p.name)).toEqual(['Ana']);

    // Llega un amigo por el enlace: Ana conserva su silla, su lugar y el rol de anfitriona.
    const beto = room.addPlayer({ name: 'Beto', avatar: 'robot' });
    expect(beto.ok).toBe(true);
    sweepFor(5_000);
    let v = room.view();
    expect(v.players.map((p) => p.name)).toEqual(['Ana', 'Beto']);
    expect(v.hostId).toBe(seatResult.playerId);
    expect(room.rejoin(seatResult.playerId, seatResult.token).ok).toBe(true);
    v = room.view();
    expect(v.players.every((p) => p.connected)).toBe(true);
    manager.dispose();
  });

  it('una sala de lobby sin nadie conectado se cierra a los emptyRoomTtlMs, no antes', () => {
    const manager = new RoomManager({ now: () => Date.now(), autoSweep: false });
    const room = manager.create({});
    const id = seat(room, 'Ana');
    room.setConnected(id, false);
    vi.advanceTimersByTime(TIMINGS.emptyRoomTtlMs - 1);
    manager.sweep();
    expect(manager.size).toBe(1);
    vi.advanceTimersByTime(1);
    manager.sweep();
    expect(manager.size).toBe(0);
  });

  it('respeta maxRooms', () => {
    const manager = new RoomManager({ now: () => Date.now(), autoSweep: false, maxRooms: 2 });
    const first = manager.create({});
    manager.create({});
    expect(manager.isFull).toBe(true);
    expect(() => manager.create({})).toThrow();
    manager.close(first.code);
    expect(manager.isFull).toBe(false);
    expect(manager.create({}).code).toMatch(/^\d{6}$/);
    manager.dispose();
  });

  it('el barrido automático corre cada segundo y dispose() lo detiene', () => {
    const manager = new RoomManager({ now: () => Date.now() });
    const room = manager.create({});
    const tick = vi.spyOn(room, 'tick');
    seat(room, 'Ana');
    vi.advanceTimersByTime(3_000);
    expect(tick).toHaveBeenCalledTimes(3);
    manager.dispose();
    vi.advanceTimersByTime(3_000);
    expect(tick).toHaveBeenCalledTimes(3);
  });
});
