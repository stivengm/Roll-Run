import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, LOG_LIMIT } from '../../shared/protocol.ts';
import type { RoomSettings, RoomView } from '../../shared/protocol.ts';
import { GAME_FINISHED, GAME_STARTED, GameRoom, SESSION_EXPIRED } from '../src/game-room.ts';
import type { Timings } from '../src/game-room.ts';

const T: Timings = {
  rollMs: 100,
  penaltyMs: 200,
  winMs: 300,
  disconnectedTurnSkipMs: 1_000,
  hostTransferMs: 2_000,
  lobbyDisconnectRemoveMs: 3_000,
  emptyRoomTtlMs: 5_000,
};

interface Setup {
  room: GameRoom;
  /** ids en orden de ingreso. */
  ids: string[];
  tokens: string[];
  dice: number[];
  changes: () => number;
  view: () => RoomView;
  /** Lanza con un valor fijo y espera la revelación. */
  rollAs: (playerId: string, value: number) => void;
}

function setup(names: string[] = [], settings: Partial<RoomSettings> = {}): Setup {
  const dice: number[] = [];
  let changes = 0;
  const room = new GameRoom(
    '123456',
    { ...DEFAULT_SETTINGS, ...settings },
    {
      now: () => Date.now(),
      rollDie: () => {
        const value = dice.shift();
        if (value === undefined) {
          throw new Error('El test no preparó el valor del dado');
        }
        return value;
      },
      timings: T,
      onChange: () => changes++,
    },
  );
  const ids: string[] = [];
  const tokens: string[] = [];
  for (const name of names) {
    vi.advanceTimersByTime(1);
    const result = room.addPlayer({ name, avatar: 'robot' });
    if (!result.ok) {
      throw new Error(result.error);
    }
    ids.push(result.playerId);
    tokens.push(result.token);
  }
  return {
    room,
    ids,
    tokens,
    dice,
    changes: () => changes,
    view: () => room.view(),
    rollAs(playerId, value) {
      dice.push(value);
      const result = room.roll(playerId);
      expect(result).toMatchObject({ ok: true });
      vi.advanceTimersByTime(T.rollMs);
    },
  };
}

function scoreOf(view: RoomView, id: string): number {
  return view.players.find((p) => p.id === id)!.score;
}

beforeEach(() => {
  vi.useFakeTimers({ now: 1_700_000_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('GameRoom · lobby', () => {
  it('ordena por orden de ingreso y el primero es el anfitrión', () => {
    const { view, ids } = setup(['Ana', 'Bea', 'Carl']);
    const v = view();
    expect(v.players.map((p) => p.name)).toEqual(['Ana', 'Bea', 'Carl']);
    expect(v.players.map((p) => p.id)).toEqual(ids);
    expect(v.players[0].joinedAt).toBeLessThan(v.players[1].joinedAt);
    expect(v.players[1].joinedAt).toBeLessThan(v.players[2].joinedAt);
    expect(v.hostId).toBe(ids[0]);
    expect(v.status).toBe('lobby');
    expect(v.round).toBe(0);
    expect(v.log.at(-1)).toMatchObject({ kind: 'join', text: 'Carl entró a la sala' });
  });

  it('rechaza la sala llena', () => {
    const { room } = setup(['Ana', 'Bea'], { maxPlayers: 2 });
    expect(room.addPlayer({ name: 'Carl', avatar: 'bolt' })).toEqual({
      ok: false,
      error: 'La sala está llena.',
    });
  });

  it('rechaza apodos duplicados sin distinguir mayúsculas, acentos ni espacios', () => {
    const { room } = setup(['Ána María']);
    expect(room.addPlayer({ name: '  ana   MARIA ', avatar: 'bolt' })).toEqual({
      ok: false,
      error: 'Ese apodo ya está en uso en esta sala.',
    });
    expect(room.addPlayer({ name: 'x', avatar: 'bolt' })).toMatchObject({ ok: false });
    // Homoglifos: 'А' cirílica y ancho completo.
    expect(room.addPlayer({ name: '\u0410na María', avatar: 'bolt' })).toMatchObject({ ok: false });
    expect(room.addPlayer({ name: 'ＡＮＡ ＭＡＲÍＡ', avatar: 'bolt' })).toMatchObject({ ok: false });
  });

  it('no deja unirse con la partida en curso', () => {
    const { room, ids } = setup(['Ana', 'Bea']);
    expect(room.start(ids[0]).ok).toBe(true);
    expect(room.addPlayer({ name: 'Carl', avatar: 'bolt' })).toEqual({
      ok: false,
      error: 'La partida ya comenzó. Espera a que termine.',
    });
  });

  it('con la partida terminada indica que se espera la revancha', () => {
    const { room, ids, view, rollAs } = setup(['Ana', 'Bea'], { targetScore: 10 });
    room.start(ids[0]);
    rollAs(ids[0], 6);
    rollAs(ids[0], 6);
    // Durante la celebración (status 'playing', phase 'won') la partida ya terminó.
    expect(view().phase).toBe('won');
    expect(room.addPlayer({ name: 'Carl', avatar: 'bolt' })).toEqual({
      ok: false,
      error: GAME_FINISHED,
    });
    vi.advanceTimersByTime(T.winMs);
    expect(view().status).toBe('finished');
    expect(room.canAddPlayer({ name: 'Carl', avatar: 'bolt' })).toEqual({
      ok: false,
      error: 'La partida acaba de terminar. Podrás entrar cuando el anfitrión inicie la revancha.',
    });
    expect(room.restart(ids[0]).ok).toBe(true);
    expect(room.addPlayer({ name: 'Carl', avatar: 'bolt' }).ok).toBe(true);
  });

  it('start exige anfitrión y al menos 2 jugadores conectados', () => {
    const solo = setup(['Ana']);
    expect(solo.room.start(solo.ids[0])).toEqual({
      ok: false,
      error: 'Se necesitan al menos 2 jugadores conectados.',
    });

    const { room, ids, view } = setup(['Ana', 'Bea', 'Carl']);
    expect(room.start(ids[1])).toEqual({
      ok: false,
      error: 'Solo el anfitrión puede iniciar la partida.',
    });
    room.setConnected(ids[1], false);
    room.setConnected(ids[2], false);
    expect(room.start(ids[0])).toEqual({
      ok: false,
      error: 'Se necesitan al menos 2 jugadores conectados.',
    });

    // Con 2 conectados arranca; Carl se acaba de desconectar (p. ej. recarga) y sigue jugando.
    room.setConnected(ids[1], true);
    expect(room.start(ids[0]).ok).toBe(true);
    const v = view();
    expect(v.players.map((p) => p.name)).toEqual(['Ana', 'Bea', 'Carl']);
    expect(v.players[2].connected).toBe(false);
    expect(v.status).toBe('playing');
    expect(v.round).toBe(1);
    expect(v.turn).toMatchObject({ playerId: ids[0], number: 1, points: 0, rolls: [] });
    expect(v.log.some((e) => e.kind === 'leave')).toBe(false);
    expect(v.log.at(-1)).toMatchObject({
      kind: 'start',
      text: '¡Comienza la partida #1! Empieza Ana',
    });
    expect(room.start(ids[0])).toEqual({ ok: false, error: 'La partida ya comenzó.' });
  });

  it('updateSettings valida anfitrión, lobby y cupo, y sanea los valores', () => {
    const { room, ids, view } = setup(['Ana', 'Bea', 'Carl']);
    expect(room.updateSettings(ids[1], { targetScore: 100 })).toEqual({
      ok: false,
      error: 'Solo el anfitrión puede cambiar las reglas.',
    });
    expect(
      room.updateSettings(ids[0], {
        targetScore: 2,
        penaltyNumber: 3,
        penaltyMode: 'all',
        maxPlayers: 2,
      }),
    ).toEqual({ ok: false, error: 'Hay más jugadores en la sala que ese cupo.' });

    expect(
      room.updateSettings(ids[0], {
        targetScore: 33,
        penaltyNumber: 9,
        penaltyMode: 'turn',
        maxPlayers: 4,
      }).ok,
    ).toBe(true);
    expect(view().settings).toEqual({
      targetScore: 35,
      penaltyNumber: 6,
      penaltyMode: 'turn',
      maxPlayers: 4,
    });
    expect(view().log.at(-1)).toMatchObject({
      kind: 'settings',
      text: 'Reglas: meta 35 · penitencia 6 (solo el turno) · cupo 4',
    });

    room.start(ids[0]);
    expect(room.updateSettings(ids[0], DEFAULT_SETTINGS)).toEqual({
      ok: false,
      error: 'Solo puedes cambiar las reglas en el lobby.',
    });
  });

  it('view() no expone tokens', () => {
    const { view, tokens } = setup(['Ana', 'Bea']);
    const json = JSON.stringify(view());
    for (const token of tokens) {
      expect(json).not.toContain(token);
    }
    expect(Object.keys(view().players[0]).sort()).toEqual(
      ['avatar', 'connected', 'id', 'joinedAt', 'name', 'score', 'stats'].sort(),
    );
  });

  it('rejoin exige el token correcto y marca al jugador conectado', () => {
    const { room, ids, tokens, view, changes } = setup(['Ana', 'Bea']);
    room.setConnected(ids[1], false);
    expect(view().players[1].connected).toBe(false);
    expect(room.rejoin(ids[1], tokens[0])).toEqual({ ok: false, error: SESSION_EXPIRED });
    expect(room.rejoin('otro', tokens[1])).toEqual({ ok: false, error: SESSION_EXPIRED });
    expect(room.rejoin(ids[1], tokens[1])).toEqual({
      ok: true,
      playerId: ids[1],
      token: tokens[1],
    });
    expect(view().players[1].connected).toBe(true);

    // Un rejoin de alguien ya conectado no cambia nada: no se difunde el estado.
    const before = changes();
    for (let i = 0; i < 5; i++) {
      expect(room.rejoin(ids[1], tokens[1]).ok).toBe(true);
    }
    expect(changes()).toBe(before);
  });

  it('en el lobby nadie sale por tiempo', () => {
    const { room, ids, view, changes } = setup(['Ana', 'Bea', 'Carl']);
    room.setConnected(ids[2], false);
    const before = changes();
    vi.advanceTimersByTime(T.lobbyDisconnectRemoveMs * 10);
    room.tick();
    expect(changes()).toBe(before);
    expect(view().players.map((p) => p.name)).toEqual(['Ana', 'Bea', 'Carl']);
  });

  it('con la sala llena, el que entra libera la silla del fantasma más antiguo', () => {
    const { room, ids, tokens, view } = setup(['Ana', 'Bea', 'Carl'], { maxPlayers: 3 });
    room.setConnected(ids[1], false);
    vi.advanceTimersByTime(100);
    room.setConnected(ids[2], false);
    const dani = { name: 'Dani', avatar: 'bolt' };
    expect(room.addPlayer(dani)).toEqual({ ok: false, error: 'La sala está llena.' });

    vi.advanceTimersByTime(T.lobbyDisconnectRemoveMs);
    expect(room.canAddPlayer(dani)).toBeNull();
    expect(view().players).toHaveLength(3);
    expect(room.addPlayer(dani).ok).toBe(true);
    const v = view();
    expect(v.players.map((p) => p.name)).toEqual(['Ana', 'Carl', 'Dani']);
    expect(v.log).toContainEqual(
      expect.objectContaining({ kind: 'leave', text: 'Bea salió de la sala (sin conexión)' }),
    );
    expect(room.rejoin(ids[1], tokens[1])).toEqual({
      ok: false,
      error: 'Perdiste tu lugar en la sala por estar desconectado. Vuelve a entrar con el código.',
    });
    // Carl sigue teniendo su silla.
    expect(room.rejoin(ids[2], tokens[2]).ok).toBe(true);
  });

  it('quien entra con el apodo de una silla fantasma la libera', () => {
    const { room, ids, view } = setup(['Ana', 'Bea']);
    room.setConnected(ids[1], false);
    expect(room.addPlayer({ name: 'bea', avatar: 'bolt' })).toEqual({
      ok: false,
      error: 'Ese apodo ya está en uso en esta sala.',
    });
    vi.advanceTimersByTime(T.lobbyDisconnectRemoveMs);
    expect(room.addPlayer({ name: 'bea', avatar: 'bolt' }).ok).toBe(true);
    expect(view().players.map((p) => p.name)).toEqual(['Ana', 'bea']);
    expect(view().players.every((p) => p.connected)).toBe(true);
  });

  it('al iniciar queda fuera quien lleva lobbyDisconnectRemoveMs desconectado', () => {
    const { room, ids, tokens, view } = setup(['Ana', 'Bea', 'Carl', 'Dani']);
    room.setConnected(ids[2], false);
    vi.advanceTimersByTime(T.lobbyDisconnectRemoveMs);
    room.setConnected(ids[3], false);
    vi.advanceTimersByTime(500);
    expect(room.start(ids[0]).ok).toBe(true);
    const v = view();
    // Carl se fue hace rato; Dani solo lleva medio segundo fuera y juega.
    expect(v.players.map((p) => p.name)).toEqual(['Ana', 'Bea', 'Dani']);
    expect(v.log).toContainEqual(
      expect.objectContaining({ kind: 'leave', text: 'Carl salió de la sala (sin conexión)' }),
    );
    expect(room.rejoin(ids[2], tokens[2])).toEqual({
      ok: false,
      error:
        'La partida empezó sin ti mientras estabas desconectado. Podrás volver a entrar en la revancha.',
    });
    expect(room.rejoin(ids[2], tokens[0])).toEqual({ ok: false, error: SESSION_EXPIRED });
    expect(room.addPlayer({ name: 'Carl', avatar: 'bolt' })).toEqual({
      ok: false,
      error: GAME_STARTED,
    });
    expect(room.rejoin(ids[3], tokens[3]).ok).toBe(true);
  });

  it('el log guarda como máximo LOG_LIMIT entradas con id incremental', () => {
    const { room, ids, view } = setup(['Ana']);
    for (let i = 0; i < LOG_LIMIT + 5; i++) {
      room.updateSettings(ids[0], { ...DEFAULT_SETTINGS, targetScore: 100 + (i % 2) * 5 });
    }
    const log = view().log;
    expect(log).toHaveLength(LOG_LIMIT);
    for (let i = 1; i < log.length; i++) {
      expect(log[i].id).toBe(log[i - 1].id + 1);
    }
  });
});

describe('GameRoom · partida', () => {
  it('sigue el orden de ingreso como orden de turnos (circular)', () => {
    const { room, ids, view, rollAs } = setup(['Ana', 'Bea', 'Carl'], { penaltyNumber: 6 });
    room.start(ids[0]);
    for (const [index, id] of [ids[0], ids[1], ids[2], ids[0]].entries()) {
      expect(view().turn).toMatchObject({ playerId: id, number: index + 1 });
      rollAs(id, 2);
      expect(room.pass(id).ok).toBe(true);
    }
    expect(view().turn?.playerId).toBe(ids[1]);
  });

  it('suma el dado de inmediato y deja seguir lanzando', () => {
    const { room, ids, view, rollAs, dice } = setup(['Ana', 'Bea'], { penaltyNumber: 1 });
    room.start(ids[0]);

    dice.push(4);
    expect(room.roll(ids[0])).toMatchObject({ ok: true });
    let v = view();
    expect(v.phase).toBe('rolling');
    expect(v.lastRoll).toMatchObject({ playerId: ids[0], value: null, scoreAfter: 0 });
    expect(scoreOf(v, ids[0])).toBe(0);
    expect(room.roll(ids[0])).toEqual({ ok: false, error: 'Espera a que termine el lanzamiento.' });
    expect(room.pass(ids[0])).toEqual({ ok: false, error: 'Espera a que termine el lanzamiento.' });
    const firstRollId = v.lastRoll!.id;

    vi.advanceTimersByTime(T.rollMs - 1);
    expect(view().phase).toBe('rolling');
    vi.advanceTimersByTime(1);

    v = view();
    expect(v.phase).toBe('idle');
    expect(v.lastRoll).toMatchObject({
      id: firstRollId,
      value: 4,
      isPenalty: false,
      scoreAfter: 4,
    });
    expect(scoreOf(v, ids[0])).toBe(4);
    expect(v.turn).toMatchObject({ playerId: ids[0], points: 4, rolls: [4] });
    expect(v.log.at(-1)).toMatchObject({ kind: 'roll', text: 'Ana sacó 4 (+4 · total 4)' });

    rollAs(ids[0], 5);
    v = view();
    expect(scoreOf(v, ids[0])).toBe(9);
    expect(v.turn).toMatchObject({ playerId: ids[0], points: 9, rolls: [4, 5] });
    expect(v.players[0].stats).toEqual({ rolls: 2, penalties: 0, bestTurn: 9 });
    expect(v.lastRoll!.id).toBe(firstRollId + 1);
  });

  it('para plantarse hay que lanzar al menos una vez', () => {
    const { room, ids, view, rollAs } = setup(['Ana', 'Bea']);
    room.start(ids[0]);
    expect(room.pass(ids[0])).toEqual({
      ok: false,
      error: 'Lanza el dado al menos una vez antes de pasar.',
    });
    rollAs(ids[0], 3);
    expect(room.pass(ids[0]).ok).toBe(true);
    const v = view();
    expect(v.turn).toMatchObject({ playerId: ids[1], number: 2, points: 0, rolls: [] });
    expect(scoreOf(v, ids[0])).toBe(3);
    expect(v.log.at(-1)).toMatchObject({
      kind: 'pass',
      text: 'Ana se plantó con 3 pts (+3 este turno)',
    });
  });

  it('no deja lanzar fuera de turno ni fuera de partida', () => {
    const { room, ids } = setup(['Ana', 'Bea']);
    expect(room.roll(ids[0])).toEqual({ ok: false, error: 'La partida no está en curso.' });
    room.start(ids[0]);
    expect(room.roll(ids[1])).toEqual({ ok: false, error: 'No es tu turno.' });
    expect(room.pass(ids[1])).toEqual({ ok: false, error: 'No es tu turno.' });
  });

  it("penitencia en modo 'all': score a 0 y el turno pasa solo tras penaltyMs", () => {
    const { room, ids, view, rollAs } = setup(['Ana', 'Bea'], {
      penaltyNumber: 1,
      penaltyMode: 'all',
    });
    room.start(ids[0]);
    rollAs(ids[0], 6);
    room.pass(ids[0]);
    rollAs(ids[1], 2);
    room.pass(ids[1]);

    rollAs(ids[0], 4);
    expect(scoreOf(view(), ids[0])).toBe(10);
    rollAs(ids[0], 1);
    let v = view();
    expect(v.phase).toBe('penalty');
    expect(scoreOf(v, ids[0])).toBe(0);
    expect(v.lastRoll).toMatchObject({ value: 1, isPenalty: true, lostPoints: 10, scoreAfter: 0 });
    expect(v.turn).toMatchObject({ playerId: ids[0], rolls: [4, 1] });
    expect(v.players[0].stats.penalties).toBe(1);
    expect(v.log.at(-1)).toMatchObject({
      kind: 'penalty',
      text: '¡Penitencia! Ana sacó 1 y perdió 10 pts · vuelve a 0',
    });
    // Durante la penitencia nadie puede actuar.
    expect(room.roll(ids[0])).toEqual({ ok: false, error: 'Espera a que termine el lanzamiento.' });
    expect(room.pass(ids[0])).toEqual({ ok: false, error: 'Espera a que termine el lanzamiento.' });

    vi.advanceTimersByTime(T.penaltyMs - 1);
    expect(view().turn?.playerId).toBe(ids[0]);
    vi.advanceTimersByTime(1);
    v = view();
    expect(v.phase).toBe('idle');
    expect(v.turn).toMatchObject({ playerId: ids[1], points: 0, rolls: [] });
    expect(scoreOf(v, ids[1])).toBe(2);
  });

  it("penitencia en modo 'turn': solo pierde lo sumado en el turno", () => {
    const { room, ids, view, rollAs } = setup(['Ana', 'Bea'], {
      penaltyNumber: 3,
      penaltyMode: 'turn',
    });
    room.start(ids[0]);
    rollAs(ids[0], 6);
    room.pass(ids[0]);
    rollAs(ids[1], 2);
    room.pass(ids[1]);
    rollAs(ids[0], 5);
    rollAs(ids[0], 4);
    expect(scoreOf(view(), ids[0])).toBe(15);
    rollAs(ids[0], 3);
    const v = view();
    expect(scoreOf(v, ids[0])).toBe(6);
    expect(v.lastRoll).toMatchObject({ isPenalty: true, lostPoints: 9, scoreAfter: 6 });
    expect(v.log.at(-1)?.text).toBe('¡Penitencia! Ana sacó 3 y perdió 9 pts');
    vi.advanceTimersByTime(T.penaltyMs);
    expect(view().turn?.playerId).toBe(ids[1]);
  });

  it('gana al llegar a la meta (>=) en el mismo lanzamiento y pasa a finished', () => {
    const { room, ids, view, rollAs } = setup(['Ana', 'Bea'], {
      targetScore: 10,
      penaltyNumber: 1,
    });
    room.start(ids[0]);
    rollAs(ids[0], 6);
    rollAs(ids[0], 5);
    let v = view();
    expect(scoreOf(v, ids[0])).toBe(11);
    expect(v.status).toBe('playing');
    expect(v.phase).toBe('won');
    expect(v.winner).toEqual({ id: ids[0], name: 'Ana', avatar: 'robot', score: 11 });
    expect(v.log.at(-1)).toMatchObject({
      kind: 'win',
      text: '¡Ana llegó a 11 pts y gana la partida!',
    });
    expect(room.roll(ids[0])).toMatchObject({ ok: false });
    expect(room.pass(ids[0])).toMatchObject({ ok: false });

    vi.advanceTimersByTime(T.winMs);
    v = view();
    expect(v.status).toBe('finished');
    expect(v.phase).toBe('idle');
    expect(v.winner?.id).toBe(ids[0]);
  });

  it('restart: solo el anfitrión, solo con la partida terminada', () => {
    const { room, ids, view, rollAs } = setup(['Ana', 'Bea'], { targetScore: 10 });
    expect(room.restart(ids[0])).toEqual({ ok: false, error: 'La partida aún no ha terminado.' });
    room.start(ids[0]);
    rollAs(ids[0], 6);
    rollAs(ids[0], 6);
    vi.advanceTimersByTime(T.winMs);
    expect(room.restart(ids[1])).toEqual({
      ok: false,
      error: 'Solo el anfitrión puede iniciar la revancha.',
    });
    expect(room.restart(ids[0]).ok).toBe(true);
    const v = view();
    expect(v.status).toBe('lobby');
    expect(v.phase).toBe('idle');
    expect(v.turn).toBeNull();
    expect(v.lastRoll).toBeNull();
    expect(v.winner).toBeNull();
    expect(v.players.every((p) => p.score === 0 && p.stats.rolls === 0)).toBe(true);
    expect(v.log.at(-1)).toMatchObject({ kind: 'reset', text: 'Revancha: todos vuelven a 0' });
    expect(room.start(ids[0]).ok).toBe(true);
    expect(view().round).toBe(2);
  });
});

describe('GameRoom · salidas, anfitrión y desconexiones', () => {
  it('expulsar al jugador del turno pasa el turno a quien iba después', () => {
    const { room, ids, view, rollAs, dice } = setup(['Ana', 'Bea', 'Carl', 'Dani'], {
      penaltyNumber: 1,
    });
    room.start(ids[0]);
    rollAs(ids[0], 2);
    room.pass(ids[0]);
    expect(view().turn?.playerId).toBe(ids[1]);

    // Bea está lanzando cuando la expulsan: el lanzamiento se descarta.
    expect(room.roll(ids[1]).ok).toBe(true);
    expect(room.removePlayer(ids[1], 'kick', ids[2])).toEqual({
      ok: false,
      error: 'Solo el anfitrión puede expulsar jugadores.',
    });
    expect(room.removePlayer(ids[0], 'kick', ids[0])).toEqual({
      ok: false,
      error: 'No puedes expulsarte a ti mismo.',
    });
    expect(room.removePlayer(ids[1], 'kick', ids[0])).toEqual({
      ok: true,
      playerId: ids[1],
      empty: false,
    });
    let v = view();
    expect(v.turn).toMatchObject({ playerId: ids[2], points: 0, rolls: [] });
    expect(v.phase).toBe('idle');
    expect(v.lastRoll).toBeNull();
    expect(v.log).toContainEqual(
      expect.objectContaining({ kind: 'kick', text: 'Bea fue expulsado por el anfitrión' }),
    );
    // El timer del lanzamiento cancelado no revela nada.
    dice.push(5);
    vi.advanceTimersByTime(T.rollMs * 2);
    expect(view().turn?.playerId).toBe(ids[2]);
    expect(dice).toEqual([5]);
    dice.length = 0;

    // Expulsar al último en orden mientras es su turno vuelve al primero.
    rollAs(ids[2], 2);
    room.pass(ids[2]);
    expect(view().turn?.playerId).toBe(ids[3]);
    room.removePlayer(ids[3], 'kick', ids[0]);
    v = view();
    expect(v.turn?.playerId).toBe(ids[0]);
    expect(v.players.map((p) => p.name)).toEqual(['Ana', 'Carl']);
  });

  it('expulsar durante la penitencia cancela el paso automático y avanza una sola vez', () => {
    const { room, ids, view, rollAs } = setup(['Ana', 'Bea', 'Carl'], { penaltyNumber: 1 });
    room.start(ids[0]);
    rollAs(ids[0], 2);
    room.pass(ids[0]);
    rollAs(ids[1], 1);
    expect(view().phase).toBe('penalty');
    room.removePlayer(ids[1], 'kick', ids[0]);
    expect(view().turn?.playerId).toBe(ids[2]);
    vi.advanceTimersByTime(T.penaltyMs * 2);
    expect(view().turn?.playerId).toBe(ids[2]);
    expect(view().phase).toBe('idle');
  });

  it('si al salir queda un solo jugador, la partida se cancela', () => {
    const { room, ids, view, rollAs } = setup(['Ana', 'Bea']);
    room.start(ids[0]);
    rollAs(ids[0], 4);
    expect(room.removePlayer(ids[1], 'leave').ok).toBe(true);
    const v = view();
    expect(v.status).toBe('lobby');
    expect(v.phase).toBe('idle');
    expect(v.turn).toBeNull();
    expect(v.lastRoll).toBeNull();
    expect(scoreOf(v, ids[0])).toBe(0);
    expect(v.log.at(-1)).toMatchObject({
      kind: 'cancel',
      text: 'Partida cancelada: no hay suficientes jugadores',
    });
    expect(room.removePlayer(ids[0], 'leave')).toEqual({ ok: true, playerId: ids[0], empty: true });
  });

  it('si sale alguien durante la victoria, la partida igual termina', () => {
    const { room, ids, view, rollAs } = setup(['Ana', 'Bea'], { targetScore: 10 });
    room.start(ids[0]);
    rollAs(ids[0], 6);
    rollAs(ids[0], 6);
    expect(view().phase).toBe('won');
    room.removePlayer(ids[1], 'leave');
    vi.advanceTimersByTime(T.winMs);
    expect(view().status).toBe('finished');
    expect(view().winner?.name).toBe('Ana');
  });

  it('si sale el anfitrión, el rol pasa al siguiente conectado', () => {
    const { room, ids, view } = setup(['Ana', 'Bea', 'Carl']);
    room.setConnected(ids[1], false);
    room.removePlayer(ids[0], 'leave');
    const v = view();
    expect(v.hostId).toBe(ids[2]);
    expect(v.log.at(-1)).toMatchObject({ kind: 'host', text: 'Ahora Carl es el anfitrión' });
  });

  it('el desconectado al iniciar juega: su turno se salta y puede volver', () => {
    const { room, ids, tokens, view, rollAs } = setup(['Ana', 'Bea', 'Carl']);
    room.setConnected(ids[1], false);
    vi.advanceTimersByTime(300);
    expect(room.start(ids[0]).ok).toBe(true);
    rollAs(ids[0], 3);
    room.pass(ids[0]);
    expect(view().turn?.playerId).toBe(ids[1]);
    vi.advanceTimersByTime(T.disconnectedTurnSkipMs);
    room.tick();
    expect(view().turn?.playerId).toBe(ids[2]);
    expect(view().log.at(-1)).toMatchObject({
      kind: 'skip',
      text: 'Se saltó el turno de Bea (desconectado)',
    });
    expect(room.rejoin(ids[1], tokens[1]).ok).toBe(true);
    expect(view().players[1].connected).toBe(true);
  });

  it('el anfitrión que esperaba solo no pierde el rol en cuanto llega alguien', () => {
    const { room, ids, view, changes } = setup(['Ana']);
    room.setConnected(ids[0], false);
    vi.advanceTimersByTime(T.hostTransferMs * 10);
    room.tick();
    const bea = room.addPlayer({ name: 'Bea', avatar: 'bolt' });
    expect(bea.ok).toBe(true);
    const before = changes();
    room.tick();
    expect(view().hostId).toBe(ids[0]);
    expect(changes()).toBe(before);
    // Solo cuenta el tiempo que Bea lleva esperando.
    vi.advanceTimersByTime(T.hostTransferMs - 1);
    room.tick();
    expect(view().hostId).toBe(ids[0]);
    vi.advanceTimersByTime(1);
    room.tick();
    expect(view().hostId).toBe(bea.ok ? bea.playerId : '');
    expect(view().players.map((p) => p.name)).toEqual(['Ana', 'Bea']);
  });

  it('transfiere el anfitrión si lleva hostTransferMs desconectado', () => {
    const { room, ids, view } = setup(['Ana', 'Bea', 'Carl']);
    room.setConnected(ids[0], false);
    vi.advanceTimersByTime(T.hostTransferMs - 1);
    room.tick();
    expect(view().hostId).toBe(ids[0]);
    vi.advanceTimersByTime(1);
    room.tick();
    expect(view().hostId).toBe(ids[1]);
    expect(view().log.some((e) => e.kind === 'host')).toBe(true);
  });

  it('salta solo el turno de un jugador desconectado', () => {
    const { room, ids, view, changes } = setup(['Ana', 'Bea', 'Carl']);
    room.start(ids[0]);
    room.setConnected(ids[0], false);
    vi.advanceTimersByTime(T.disconnectedTurnSkipMs - 1);
    const before = changes();
    room.tick();
    expect(changes()).toBe(before);
    expect(view().turn?.playerId).toBe(ids[0]);
    vi.advanceTimersByTime(1);
    room.tick();
    const v = view();
    expect(v.turn?.playerId).toBe(ids[1]);
    expect(v.log.at(-1)).toMatchObject({
      kind: 'skip',
      text: 'Se saltó el turno de Ana (desconectado)',
    });
  });

  it('el anfitrión puede saltar el turno de un desconectado (y solo de él)', () => {
    const { room, ids, view, rollAs } = setup(['Ana', 'Bea', 'Carl']);
    room.start(ids[0]);
    rollAs(ids[0], 3);
    room.pass(ids[0]);
    expect(room.skip(ids[0])).toEqual({
      ok: false,
      error: 'Solo puedes saltar el turno de un jugador desconectado.',
    });
    room.setConnected(ids[1], false);
    expect(room.skip(ids[2])).toEqual({
      ok: false,
      error: 'Solo el anfitrión puede saltar turnos.',
    });
    expect(room.skip(ids[0]).ok).toBe(true);
    expect(view().turn?.playerId).toBe(ids[2]);
  });

  it('dispose() cancela los timers pendientes', () => {
    const { room, ids, view, dice, changes } = setup(['Ana', 'Bea']);
    room.start(ids[0]);
    dice.push(4);
    room.roll(ids[0]);
    const before = changes();
    room.dispose();
    vi.advanceTimersByTime(T.rollMs * 2);
    expect(changes()).toBe(before);
    expect(view().phase).toBe('rolling');
  });
});
