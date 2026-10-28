import { createReadStream, existsSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Server } from 'socket.io';
import type { ClientToServerEvents, ServerToClientEvents } from '../../shared/protocol.ts';
import type { Timings } from './game-room.ts';
import { ConnectionCounter, clientKey, limitsFromEnv, resolveLimits } from './limits.ts';
import type { ServerLimits } from './limits.ts';
import { RoomManager } from './room-manager.ts';
import { registerSocketHandlers } from './socket-handlers.ts';
import type { GameIO, SocketData, SocketHandlers } from './socket-handlers.ts';

export interface GameServerOptions {
  /** Carpeta del build de Angular a servir. `null`/ausente = solo API (health + Socket.IO). */
  staticDir?: string | null;
  rollDie?: () => number;
  timings?: Partial<Timings>;
  now?: () => number;
  corsOrigin?: string | string[] | boolean;
  /** Topes anti-abuso. Lo no indicado sale de las variables de entorno o del valor por defecto. */
  limits?: Partial<ServerLimits>;
}

export interface GameServer {
  httpServer: HttpServer;
  io: GameIO;
  manager: RoomManager;
  /** Empieza a escuchar y devuelve el puerto real (útil con `port = 0`). */
  listen(port: number, host?: string): Promise<number>;
  close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/** Lo que se usa de una conexión de Engine.IO (el paquete no es dependencia directa). */
interface EngineConnection {
  request: IncomingMessage;
  once(event: 'close', listener: () => void): void;
}

/** Nombres con hash de contenido de Angular, p. ej. `main-5NZ3JEHK.js`. */
const HASHED_FILE_RE = /-[A-Z0-9]{8,}(?:\.[a-z0-9]+)+$/;

function corsFromEnv(): string[] | undefined {
  const raw = process.env.CORS_ORIGIN?.trim();
  if (!raw) {
    return undefined;
  }
  const origins = raw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return origins.length ? origins : undefined;
}

function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

/**
 * Convierte el pathname de la URL en una ruta absoluta dentro de `root`, o `null` si la ruta es
 * sospechosa o se sale de la carpeta.
 */
export function resolveStaticPath(root: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const segments = decoded.split('/');
  // Rechaza bytes nulos, barras invertidas, ".." y archivos ocultos (.env, .git…).
  if (decoded.includes('\0') || decoded.includes('\\') || segments.some((s) => s.startsWith('.'))) {
    return null;
  }
  const resolved = path.resolve(root, '.' + path.posix.normalize('/' + decoded));
  return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null;
}

async function fileAt(filePath: string): Promise<{ size: number } | null> {
  try {
    const info = await stat(filePath);
    return info.isFile() ? { size: info.size } : null;
  } catch {
    return null;
  }
}

function streamFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  size: number,
): void {
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath);
  // Con hash: inmutable. El resto (index.html, favicon, builds de desarrollo): revalidar siempre.
  const cacheControl = HASHED_FILE_RE.test(name)
    ? 'public, max-age=31536000, immutable'
    : 'no-cache';
  res.writeHead(200, {
    'Content-Type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
    'Content-Length': size,
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  const stream = createReadStream(filePath);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

async function serveStatic(
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): Promise<void> {
  const filePath = resolveStaticPath(root, pathname === '/' ? '/index.html' : pathname);
  if (!filePath) {
    sendText(res, 400, 'Solicitud inválida');
    return;
  }
  const file = await fileAt(filePath);
  if (file) {
    streamFile(req, res, filePath, file.size);
    return;
  }
  // Fallback SPA: las rutas del router de Angular (sin extensión) devuelven index.html.
  if (path.posix.extname(pathname) === '') {
    const indexPath = path.join(root, 'index.html');
    const index = await fileAt(indexPath);
    if (index) {
      streamFile(req, res, indexPath, index.size);
      return;
    }
  }
  sendText(res, 404, 'No encontrado');
}

export function createGameServer(options: GameServerOptions = {}): GameServer {
  const staticDir =
    options.staticDir && existsSync(options.staticDir) && statSync(options.staticDir).isDirectory()
      ? path.resolve(options.staticDir)
      : null;
  const startedAt = Date.now();
  const limits = resolveLimits({ ...limitsFromEnv(), ...options.limits });

  // `handlers` se asigna justo después de crear Socket.IO; las salas aún no existen antes.
  let handlers: SocketHandlers | null = null;
  const manager = new RoomManager({
    now: options.now,
    rollDie: options.rollDie,
    timings: options.timings,
    maxRooms: limits.maxRooms,
    onRoomChange: (room) => handlers?.broadcast(room),
    onRoomClosed: (room, reason) => handlers?.roomClosed(room, reason),
  });

  let warnedAboutProxy = false;
  function requestKey(req: IncomingMessage): string {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded && limits.trustProxyHops === 0 && !warnedAboutProxy) {
      warnedAboutProxy = true;
      console.warn(
        '[límites] Llegan conexiones con X-Forwarded-For pero TRUST_PROXY no está definido: ' +
          'los límites por IP verán a todos los clientes como la IP del proxy.',
      );
    }
    return clientKey(req.socket.remoteAddress, forwarded, limits.trustProxyHops);
  }
  const connectionsByIp = new ConnectionCounter(limits.maxConnectionsPerIp);

  const httpServer = createServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET';
      let pathname: string;
      try {
        pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
      } catch {
        sendText(res, 400, 'Solicitud inválida');
        return;
      }
      if (method !== 'GET' && method !== 'HEAD') {
        sendText(res, 405, 'Método no permitido', { Allow: 'GET, HEAD' });
        return;
      }
      if (pathname === '/health') {
        sendJson(res, 200, {
          ok: true,
          rooms: manager.size,
          uptime: Math.round((Date.now() - startedAt) / 1000),
        });
        return;
      }
      if (!staticDir) {
        sendText(res, 404, 'No encontrado');
        return;
      }
      await serveStatic(staticDir, req, res, pathname);
    })().catch((err: unknown) => {
      console.error('[http] error atendiendo la petición', err);
      if (!res.headersSent) {
        sendText(res, 500, 'Error interno del servidor');
      } else {
        res.destroy();
      }
    });
  });

  const io: GameIO = new Server<
    ClientToServerEvents,
    ServerToClientEvents,
    Record<string, never>,
    SocketData
  >(httpServer, {
    cors: { origin: options.corsOrigin ?? corsFromEnv() ?? true },
    pingInterval: 10_000,
    pingTimeout: 8_000,
    maxHttpBufferSize: 10_000,
    serveClient: false,
    // Solo se consulta en el handshake: tope global y por IP de conexiones simultáneas. Al ser
    // un rechazo a nivel HTTP, el cliente reintenta solo con su backoff.
    allowRequest: (req, callback) => {
      const full =
        io.engine.clientsCount >= limits.maxConnections ||
        !connectionsByIp.canAccept(requestKey(req));
      callback(full ? 'Demasiadas conexiones. Inténtalo en un momento.' : null, !full);
    },
  });
  io.engine.on('connection', (raw: EngineConnection) => {
    const key = requestKey(raw.request);
    connectionsByIp.add(key);
    raw.once('close', () => connectionsByIp.remove(key));
  });
  handlers = registerSocketHandlers(io, manager, { limits, now: options.now });

  let closing: Promise<void> | null = null;

  return {
    httpServer,
    io,
    manager,
    listen(port, host) {
      return new Promise<number>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        httpServer.once('error', onError);
        httpServer.listen(port, host, () => {
          httpServer.off('error', onError);
          resolve((httpServer.address() as AddressInfo).port);
        });
      });
    },
    close() {
      closing ??= new Promise<void>((resolve) => {
        manager.dispose();
        // io.close() desconecta los sockets y cierra también el servidor HTTP.
        void io.close(() => resolve());
        httpServer.closeAllConnections();
      });
      return closing;
    },
  };
}
