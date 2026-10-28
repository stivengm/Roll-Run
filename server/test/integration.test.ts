import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io as connect } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  Ack,
  ClientToServerEvents,
  JoinResult,
  RoomView,
  ServerToClientEvents,
  SessionInfo,
} from '../../shared/protocol.ts';
import { createGameServer } from '../src/app.ts';
import type { GameServer } from '../src/app.ts';
import { SESSION_EXPIRED } from '../src/game-room.ts';
import type { ServerLimits } from '../src/limits.ts';
import {
  SERVER_FULL,
  TOO_FAST,
  TOO_MANY_JOIN_ATTEMPTS,
  TOO_MANY_ROOMS,
} from '../src/socket-handlers.ts';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;

const WAIT_MS = 3000;

/** `ip` simula la IP del cliente con X-Forwarded-For (el servidor debe confiar en el proxy). */
function connectClient(port: number, ip?: string): Promise<Client> {
  const client: Client = connect(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
    extraHeaders: ip ? { 'x-forwarded-for': ip } : undefined,
  });
  return new Promise((resolve, reject) => {
    client.once('connect', () => resolve(client));
    client.once('connect_error', reject);
  });
}

/** Emite con ack y devuelve la respuesta cruda `{ ok, data | error }`. */
function send<T = null>(client: Client, event: keyof ClientToServerEvents, payload: unknown) {
  const emitter = client.timeout(WAIT_MS) as unknown as {
    emitWithAck(ev: string, data: unknown): Promise<Ack<T>>;
  };
  return emitter.emitWithAck(event, payload);
}

async function sendOk<T = null>(
  client: Client,
  event: keyof ClientToServerEvents,
  payload: unknown,
): Promise<T> {
  const response = await send<T>(client, event, payload);
  if (!response.ok) {
    throw new Error(`${event}: ${response.error}`);
  }
  return response.data;
}

/** Próximo `room:state` que cumpla la condición (registrar ANTES de la acción). */
function nextState(client: Client, predicate: (room: RoomView) => boolean): Promise<RoomView> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.off('room:state', listener);
      reject(new Error('Timeout esperando room:state'));
    }, WAIT_MS);
    const listener = (room: RoomView) => {
      if (predicate(room)) {
        clearTimeout(timer);
        client.off('room:state', listener);
        resolve(room);
      }
    };
    client.on('room:state', listener);
  });
}

function nextKicked(client: Client): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timeout esperando room:kicked')), WAIT_MS);
    client.once('room:kicked', ({ reason }) => {
      clearTimeout(timer);
      resolve(reason);
    });
  });
}

function scoreOf(room: RoomView, playerId: string): number {
  return room.players.find((p) => p.id === playerId)!.score;
}

describe('servidor Socket.IO (integración)', () => {
  const dice: number[] = [];
  const clients: Client[] = [];
  let server: GameServer;
  let port: number;

  beforeAll(async () => {
    server = createGameServer({
      staticDir: null,
      rollDie: () => dice.shift() ?? 2,
      timings: { rollMs: 20, penaltyMs: 20, winMs: 20 },
    });
    port = await server.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    for (const client of clients) {
      client.disconnect();
    }
    await server.close();
  });

  async function newClient(): Promise<Client> {
    const client = await connectClient(port);
    clients.push(client);
    return client;
  }

  it('responde /health', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as { ok: boolean; rooms: number; uptime: number };
    expect(body).toMatchObject({ ok: true, rooms: 0 });
    expect(typeof body.uptime).toBe('number');
  });

  it('juega una partida completa con 3 clientes reales', async () => {
    const ana = await newClient();
    const bea = await newClient();
    const carl = await newClient();

    // --- Crear y unirse --------------------------------------------------------------
    const created = await sendOk<JoinResult>(ana, 'room:create', {
      profile: { name: 'Ana', avatar: 'bolt' },
      settings: { targetScore: 20, penaltyNumber: 1, penaltyMode: 'all', maxPlayers: 4 },
    });
    const code = created.session.code;
    expect(code).toMatch(/^\d{6}$/);
    expect(created.room.hostId).toBe(created.session.playerId);
    expect(created.room.settings).toEqual({
      targetScore: 20,
      penaltyNumber: 1,
      penaltyMode: 'all',
      maxPlayers: 4,
    });
    expect(JSON.stringify(created.room)).not.toContain(created.session.token);

    const anaSeesBea = nextState(ana, (r) => r.players.length === 2);
    const beaJoin = await sendOk<JoinResult>(bea, 'room:join', {
      code,
      profile: { name: 'Bea', avatar: 'robot' },
    });
    await anaSeesBea;

    const dup = await send(carl, 'room:join', { code, profile: { name: 'bea', avatar: 'robot' } });
    expect(dup).toEqual({ ok: false, error: 'Ese apodo ya está en uso en esta sala.' });
    const missing = await send(carl, 'room:join', {
      code: code === '999999' ? '999998' : '999999',
      profile: { name: 'Carl', avatar: 'skull' },
    });
    expect(missing.ok).toBe(false);

    const carlJoin = await sendOk<JoinResult>(carl, 'room:join', {
      code: `${code.slice(0, 3)} · ${code.slice(3)}`,
      profile: { name: 'Carl', avatar: 'skull' },
    });
    const [A, B, C] = [
      created.session.playerId,
      beaJoin.session.playerId,
      carlJoin.session.playerId,
    ];
    expect(carlJoin.room.players.map((p) => p.name)).toEqual(['Ana', 'Bea', 'Carl']);
    expect(carlJoin.room.players.map((p) => p.id)).toEqual([A, B, C]);

    const health = (await (await fetch(`http://127.0.0.1:${port}/health`)).json()) as {
      rooms: number;
    };
    expect(health.rooms).toBe(1);

    // --- Errores por ack -------------------------------------------------------------
    expect(await send(bea, 'game:start', {})).toEqual({
      ok: false,
      error: 'Solo el anfitrión puede iniciar la partida.',
    });
    // Payload basura y ack ausente no tumban el servidor.
    (bea as unknown as { emit(ev: string, data: unknown): void }).emit('game:start', 'basura');
    expect(await send(bea, 'room:settings', 'basura')).toMatchObject({ ok: false });

    // --- Inicio ----------------------------------------------------------------------
    const started = nextState(carl, (r) => r.status === 'playing');
    await sendOk(ana, 'game:start', {});
    expect((await started).turn).toMatchObject({ playerId: A, number: 1 });

    expect(await send(bea, 'game:roll', {})).toEqual({ ok: false, error: 'No es tu turno.' });

    // --- Lanzar (ack inmediato) y plantarse ------------------------------------------
    dice.push(5);
    const rolling = nextState(bea, (r) => r.phase === 'rolling');
    const revealed = nextState(bea, (r) => r.lastRoll?.value === 5);
    await sendOk(ana, 'game:roll', {});
    expect((await rolling).lastRoll).toMatchObject({ playerId: A, value: null });
    expect(await send(ana, 'game:roll', {})).toEqual({
      ok: false,
      error: 'Espera a que termine el lanzamiento.',
    });
    const afterRoll = await revealed;
    expect(scoreOf(afterRoll, A)).toBe(5);
    expect(afterRoll.phase).toBe('idle');

    const beaTurn = nextState(carl, (r) => r.turn?.playerId === B);
    await sendOk(ana, 'game:pass', {});
    expect((await beaTurn).turn?.number).toBe(2);

    // --- Penitencia: Bea pierde todo y el turno pasa solo a Carl ----------------------
    dice.push(4);
    let state = nextState(ana, (r) => r.lastRoll?.value === 4);
    await sendOk(bea, 'game:roll', {});
    expect(scoreOf(await state, B)).toBe(4);

    dice.push(1);
    const penalty = nextState(ana, (r) => r.phase === 'penalty');
    const carlTurn = nextState(ana, (r) => r.turn?.playerId === C && r.phase === 'idle');
    await sendOk(bea, 'game:roll', {});
    const penalized = await penalty;
    expect(scoreOf(penalized, B)).toBe(0);
    expect(penalized.lastRoll).toMatchObject({ isPenalty: true, lostPoints: 4 });
    expect((await carlTurn).turn?.number).toBe(3);

    // --- Reconexión: otra pestaña toma la silla; el socket viejo no la marca offline --
    const carlSession: SessionInfo = carlJoin.session;
    const carl2 = await newClient();
    const replaced = nextKicked(carl);
    const carl2Join = await sendOk<JoinResult>(carl2, 'room:rejoin', carlSession);
    expect(carl2Join.session).toEqual(carlSession);
    expect(await replaced).toBe('Abriste esta sala en otra pestaña.');
    carl.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(
      server.manager.get(code)!.view().players.find((p) => p.id === C)!.connected,
    ).toBe(true);

    // Desconexión real y vuelta con un socket nuevo.
    const offline = nextState(ana, (r) => r.players.some((p) => p.id === C && !p.connected));
    carl2.disconnect();
    await offline;
    expect(await send(ana, 'room:rejoin', { ...carlSession, token: 'f'.repeat(32) })).toEqual({
      ok: false,
      error: SESSION_EXPIRED,
    });
    const carl3 = await newClient();
    const online = nextState(ana, (r) => r.players.some((p) => p.id === C && p.connected));
    const rejoined = await sendOk<JoinResult>(carl3, 'room:rejoin', carlSession);
    expect(rejoined.room.turn?.playerId).toBe(C);
    await online;

    // Repetir el rejoin estando conectado no difunde nada a los demás.
    let echoes = 0;
    const countEcho = () => echoes++;
    ana.on('room:state', countEcho);
    for (let i = 0; i < 5; i++) {
      await sendOk<JoinResult>(carl3, 'room:rejoin', carlSession);
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
    ana.off('room:state', countEcho);
    expect(echoes).toBe(0);

    // --- Expulsión -------------------------------------------------------------------
    expect(await send(bea, 'room:kick', { playerId: C })).toEqual({
      ok: false,
      error: 'Solo el anfitrión puede expulsar jugadores.',
    });
    const kicked = nextKicked(bea);
    const twoLeft = nextState(carl3, (r) => r.players.length === 2);
    await sendOk(ana, 'room:kick', { playerId: B });
    expect(await kicked).toBe('El anfitrión te expulsó de la sala.');
    const afterKick = await twoLeft;
    expect(afterKick.players.map((p) => p.id)).toEqual([A, C]);
    expect(afterKick.turn?.playerId).toBe(C);
    expect(await send(bea, 'game:roll', {})).toEqual({
      ok: false,
      error: 'No estás en ninguna sala.',
    });

    // --- Carl llega a la meta (20) y la sala pasa a 'finished' -------------------------
    for (const value of [6, 6, 6]) {
      dice.push(value);
      state = nextState(ana, (r) => r.lastRoll?.value === value && r.phase === 'idle');
      await sendOk(carl3, 'game:roll', {});
      await state;
    }
    dice.push(2);
    const won = nextState(ana, (r) => r.phase === 'won');
    const finished = nextState(ana, (r) => r.status === 'finished');
    await sendOk(carl3, 'game:roll', {});
    const wonState = await won;
    expect(wonState.winner).toMatchObject({ id: C, name: 'Carl', score: 20 });
    const finalState = await finished;
    expect(finalState.phase).toBe('idle');
    expect(scoreOf(finalState, C)).toBe(20);

    // --- Revancha y salida ----------------------------------------------------------
    const lobby = nextState(carl3, (r) => r.status === 'lobby');
    await sendOk(ana, 'game:restart', {});
    expect((await lobby).players.every((p) => p.score === 0)).toBe(true);

    const hostMoved = nextState(carl3, (r) => r.hostId === C && r.players.length === 1);
    await sendOk(ana, 'room:leave', {});
    await hostMoved;
    await sendOk(carl3, 'room:leave', {});
    expect(server.manager.size).toBe(0);
  });

  it('cambiar de sala saca al jugador de la anterior y avisa si la sala se cierra', async () => {
    const host = await newClient();
    const guest = await newClient();
    const first = await sendOk<JoinResult>(host, 'room:create', {
      profile: { name: 'Host', avatar: 'bolt' },
      settings: {},
    });
    await sendOk(guest, 'room:join', {
      code: first.session.code,
      profile: { name: 'Guest', avatar: 'paw' },
    });

    const guestSeesLeave = nextState(guest, (r) => r.players.length === 1);
    const second = await sendOk<JoinResult>(host, 'room:create', {
      profile: { name: 'Host', avatar: 'bolt' },
      settings: {},
    });
    expect(second.session.code).not.toBe(first.session.code);
    const left = await guestSeesLeave;
    expect(left.hostId).not.toBe(first.session.playerId);

    const closed = nextKicked(guest);
    server.manager.close(first.session.code);
    expect(await closed).toBe('La sala se cerró.');
    expect(await send(guest, 'game:start', {})).toMatchObject({ ok: false });
  });
});

describe('servidor Socket.IO (límites anti-abuso)', () => {
  const clients: Client[] = [];
  const servers: GameServer[] = [];

  afterAll(async () => {
    for (const client of clients) {
      client.disconnect();
    }
    await Promise.all(servers.map((s) => s.close()));
  });

  /** Servidor propio detrás de un "proxy" de confianza para simular IPs distintas. */
  async function startServer(limits: Partial<ServerLimits>): Promise<number> {
    const server = createGameServer({ staticDir: null, limits: { trustProxyHops: 1, ...limits } });
    servers.push(server);
    return server.listen(0, '127.0.0.1');
  }

  async function client(port: number, ip: string): Promise<Client> {
    const c = await connectClient(port, ip);
    clients.push(c);
    return c;
  }

  function create(c: Client, name: string) {
    return send<JoinResult>(c, 'room:create', { profile: { name, avatar: 'bolt' }, settings: {} });
  }

  it('bloquea a la IP que adivina códigos sin afectar a las demás', async () => {
    const port = await startServer({ joinFailures: 3 });
    const host = await client(port, '203.0.113.1');
    const code = (await sendOk<JoinResult>(host, 'room:create', {
      profile: { name: 'Anfitrion', avatar: 'bolt' },
      settings: {},
    })).session.code;
    const wrong = code === '100000' ? '100001' : '100000';

    const attacker = await client(port, '198.51.100.66');
    const profile = { name: 'Intruso', avatar: 'skull' };
    for (let i = 0; i < 3; i++) {
      expect(await send(attacker, 'room:join', { code: wrong, profile })).toEqual({
        ok: false,
        error: 'No encontramos esa sala. Revisa el código.',
      });
    }
    // Bloqueada, ni siquiera el código correcto entra (no se delata qué salas existen).
    expect(await send(attacker, 'room:join', { code, profile })).toEqual({
      ok: false,
      error: TOO_MANY_JOIN_ATTEMPTS,
    });
    // Abrir otro socket desde la misma IP no sirve.
    const again = await client(port, '198.51.100.66');
    expect(await send(again, 'room:join', { code, profile })).toMatchObject({ ok: false });

    // El rejoin tampoco sirve para buscar salas: misma respuesta exista o no.
    const fake = { playerId: 'abc', token: 'f'.repeat(32) };
    expect(await send(attacker, 'room:rejoin', { ...fake, code })).toEqual({
      ok: false,
      error: SESSION_EXPIRED,
    });
    expect(await send(attacker, 'room:rejoin', { ...fake, code: wrong })).toEqual({
      ok: false,
      error: SESSION_EXPIRED,
    });

    const friend = await client(port, '192.0.2.10');
    const joined = await sendOk<JoinResult>(friend, 'room:join', {
      code,
      profile: { name: 'Amiga', avatar: 'paw' },
    });
    expect(joined.room.players.map((p) => p.name)).toEqual(['Anfitrion', 'Amiga']);
  });

  it('limita la creación de salas por IP y el total de salas', async () => {
    const port = await startServer({ roomCreateBurst: 2, roomCreatesPerMinute: 1, maxRooms: 3 });
    const [a1, a2, a3] = await Promise.all([1, 2, 3].map(() => client(port, '203.0.113.5')));
    expect((await create(a1, 'Uno')).ok).toBe(true);
    expect((await create(a2, 'Dos')).ok).toBe(true);
    expect(await create(a3, 'Tres')).toEqual({ ok: false, error: TOO_MANY_ROOMS });

    const b = await client(port, '203.0.113.6');
    const third = await create(b, 'Bea');
    expect(third.ok).toBe(true);
    const c = await client(port, '203.0.113.7');
    expect(await create(c, 'Caro')).toEqual({ ok: false, error: SERVER_FULL });

    // Con el servidor lleno, unirse y reconectarse a salas existentes sigue funcionando.
    if (!third.ok) {
      throw new Error(third.error);
    }
    const guest = await sendOk<JoinResult>(c, 'room:join', {
      code: third.data.session.code,
      profile: { name: 'Caro', avatar: 'paw' },
    });
    b.disconnect();
    const b2 = await client(port, '203.0.113.6');
    expect((await send(b2, 'room:rejoin', third.data.session)).ok).toBe(true);
    expect(guest.room.players).toHaveLength(2);
  });

  it('frena a un socket que manda demasiados eventos seguidos', async () => {
    const port = await startServer({ eventBurst: 5, eventsPerSecond: 1 });
    const spammer = await client(port, '203.0.113.20');
    const answers = [];
    for (let i = 0; i < 7; i++) {
      answers.push(await send(spammer, 'game:roll', {}));
    }
    expect(answers.slice(0, 5)).toEqual(
      Array(5).fill({ ok: false, error: 'No estás en ninguna sala.' }),
    );
    expect(answers.slice(5)).toEqual(Array(2).fill({ ok: false, error: TOO_FAST }));
    // Otro socket tiene su propia cuota.
    const calm = await client(port, '203.0.113.20');
    expect(await send(calm, 'game:roll', {})).toEqual({
      ok: false,
      error: 'No estás en ninguna sala.',
    });
  });

  it('limita las conexiones simultáneas por IP', async () => {
    const port = await startServer({ maxConnectionsPerIp: 2 });
    const first = await client(port, '203.0.113.30');
    await client(port, '203.0.113.30');
    await expect(connectClient(port, '203.0.113.30')).rejects.toThrow();
    await client(port, '203.0.113.31');
    // Al cerrar una, vuelve a haber cupo.
    first.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 80));
    await client(port, '203.0.113.30');
  });
});

describe('servidor HTTP estático', () => {
  let server: GameServer;
  let port: number;
  let base: string;
  let dir: string;

  beforeAll(async () => {
    // base/secreto.txt queda FUERA de la carpeta servida (base/browser).
    base = mkdtempSync(path.join(tmpdir(), 'rollyrun-static-'));
    dir = path.join(base, 'browser');
    mkdirSync(dir);
    writeFileSync(path.join(base, 'secreto.txt'), 'SECRETO');
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Roll&Run</title>');
    writeFileSync(path.join(dir, 'main-ABCD2345.js'), 'console.log(1)');
    writeFileSync(path.join(dir, 'favicon.ico'), 'ico');
    mkdirSync(path.join(dir, 'media'));
    writeFileSync(path.join(dir, 'media', 'font-QWERTY12.woff2'), 'font');
    server = createGameServer({ staticDir: dir });
    port = await server.listen(0, '127.0.0.1');
  });

  afterAll(async () => {
    await server.close();
    rmSync(base, { recursive: true, force: true });
  });

  /** Petición cruda (sin normalizar la ruta como haría fetch). */
  function raw(pathname: string, method = 'GET') {
    return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
      (resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, path: pathname, method }, (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => (body += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
        });
        req.on('error', reject);
        req.end();
      },
    );
  }

  it('sirve index.html sin caché y archivos con hash como inmutables', async () => {
    const index = await raw('/');
    expect(index.status).toBe(200);
    expect(index.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(index.headers['cache-control']).toBe('no-cache');
    expect(index.body).toContain('Roll&Run');

    const js = await raw('/main-ABCD2345.js');
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(js.headers['cache-control']).toContain('immutable');

    const font = await raw('/media/font-QWERTY12.woff2');
    expect(font.headers['content-type']).toBe('font/woff2');

    const ico = await raw('/favicon.ico');
    expect(ico.headers['content-type']).toBe('image/x-icon');
    expect(ico.headers['cache-control']).not.toContain('immutable');

    const head = await raw('/main-ABCD2345.js', 'HEAD');
    expect(head.status).toBe(200);
    expect(head.body).toBe('');
  });

  it('hace fallback SPA a index.html solo para rutas sin extensión', async () => {
    const spa = await raw('/sala/123456');
    expect(spa.status).toBe(200);
    expect(spa.headers['content-type']).toBe('text/html; charset=utf-8');
    expect((await raw('/no-existe.js')).status).toBe(404);
    expect((await raw('/health')).headers['content-type']).toContain('application/json');
  });

  it('bloquea path traversal y bytes nulos', async () => {
    for (const evil of [
      '/..%2fsecreto.txt',
      '/media/..%2f..%2fsecreto.txt',
      '/..%5csecreto.txt',
      '/index.html%00.js',
      '/%00',
      '/.env',
      '/media/.hidden',
    ]) {
      const res = await raw(evil);
      expect(res.status, evil).toBe(400);
    }
    // El parser de URL resuelve "..": la ruta queda dentro de la carpeta y no existe.
    const normalizedPaths = ['/../secreto.txt', '/%2e%2e/secreto.txt', '/media/../../secreto.txt'];
    for (const normalized of normalizedPaths) {
      const res = await raw(normalized);
      expect(res.status, normalized).toBe(404);
      expect(res.body).not.toContain('SECRETO');
    }
    expect((await raw('/%E0%A4%A')).status).toBe(400);
    expect((await raw('/', 'POST')).status).toBe(405);
  });
});
