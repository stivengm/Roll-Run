import { existsSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createGameServer } from './app.ts';

const browserDir = path.resolve(import.meta.dirname, '../../dist/rollyrun/browser');
const staticDir = existsSync(path.join(browserDir, 'index.html')) ? browserDir : null;

// `--port` gana sobre PORT: en desarrollo el proxy de `ng serve` apunta fijo al 3000
// aunque el entorno traiga un PORT pensado para otra cosa.
const { values: args } = parseArgs({ options: { port: { type: 'string' } }, strict: false });
const port = parsePort(typeof args.port === 'string' ? args.port : process.env.PORT, 3000);
const host = process.env.HOST?.trim() || '0.0.0.0';

const server = createGameServer({ staticDir });
const actualPort = await server.listen(port, host);

console.log(`Roll&Run server en http://localhost:${actualPort}`);
if (!staticDir) {
  console.log('Sin build del cliente (dist/rollyrun/browser): solo Socket.IO y /health.');
}

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  console.log(`\n${signal} recibido: cerrando servidor…`);
  // Si algo queda colgado, no esperar para siempre.
  setTimeout(() => process.exit(1), 5000).unref();
  server.close().then(
    () => process.exit(0),
    (err: unknown) => {
      console.error('Error al cerrar el servidor', err);
      process.exit(1);
    },
  );
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

function parsePort(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return raw && Number.isInteger(value) && value >= 0 && value < 65536 ? value : fallback;
}
