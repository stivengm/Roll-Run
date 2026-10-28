import { isIPv4, isIPv6 } from 'node:net';

/** Topes anti-abuso del servidor. `Infinity` desactiva un tope. */
export interface ServerLimits {
  /** Salas activas como máximo en todo el servidor. */
  maxRooms: number;
  /** Conexiones simultáneas como máximo en todo el servidor. */
  maxConnections: number;
  /** Conexiones simultáneas por IP (alto: en una fiesta todos comparten Wi-Fi). */
  maxConnectionsPerIp: number;
  /** Salas que una IP puede crear de golpe y ritmo de recarga por minuto. */
  roomCreateBurst: number;
  roomCreatesPerMinute: number;
  /** Códigos inexistentes que tolera una IP dentro de la ventana antes de bloquearla. */
  joinFailures: number;
  joinFailureWindowMs: number;
  /** Primer bloqueo; se duplica con cada bloqueo seguido hasta `joinMaxBlockMs`. */
  joinBlockMs: number;
  joinMaxBlockMs: number;
  /** Eventos por segundo y ráfaga que acepta cada socket. */
  eventsPerSecond: number;
  eventBurst: number;
  /**
   * Proxies de confianza delante del servidor. Con 0 se ignora `X-Forwarded-For` (se puede
   * falsificar); con N se toma la N-ésima entrada contando desde la derecha.
   */
  trustProxyHops: number;
}

export const DEFAULT_LIMITS: ServerLimits = {
  maxRooms: 2000,
  maxConnections: 5000,
  maxConnectionsPerIp: 60,
  roomCreateBurst: 10,
  roomCreatesPerMinute: 10,
  joinFailures: 10,
  joinFailureWindowMs: 60_000,
  joinBlockMs: 60_000,
  joinMaxBlockMs: 15 * 60_000,
  eventsPerSecond: 10,
  eventBurst: 20,
  trustProxyHops: 0,
};

/** `DEFAULT_LIMITS` con los overrides válidos (números >= 0, se admite `Infinity`). */
export function resolveLimits(overrides: Partial<ServerLimits> = {}): ServerLimits {
  const limits: ServerLimits = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(limits) as (keyof ServerLimits)[]) {
    const value = overrides[key];
    if (typeof value === 'number' && !Number.isNaN(value) && value >= 0) {
      limits[key] = value;
    }
  }
  return limits;
}

function envInt(raw: string | undefined): number | undefined {
  const value = Number(raw?.trim());
  return raw?.trim() && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** `MAX_ROOMS`, `MAX_CONNECTIONS`, `MAX_CONNECTIONS_PER_IP` y `TRUST_PROXY` (saltos o `true`). */
export function limitsFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<ServerLimits> {
  const trust = env['TRUST_PROXY']?.trim().toLowerCase();
  const raw: Partial<ServerLimits> = {
    maxRooms: envInt(env['MAX_ROOMS']),
    maxConnections: envInt(env['MAX_CONNECTIONS']),
    maxConnectionsPerIp: envInt(env['MAX_CONNECTIONS_PER_IP']),
    trustProxyHops: trust === 'true' || trust === 'yes' ? 1 : envInt(trust),
  };
  return Object.fromEntries(
    Object.entries(raw).filter(([, value]) => value !== undefined),
  ) as Partial<ServerLimits>;
}

// ------------------------------------------------------------------ IP del cliente

function firstHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value.join(',') : (value ?? '');
}

/** IPv6 agrupada por su prefijo /64 (un mismo cliente suele tener todo el bloque). */
function ipv6Prefix(ip: string): string {
  const [head, tail] = ip.includes('::') ? ip.split('::') : [ip, undefined];
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  // Una IPv4 incrustada al final ocupa dos grupos.
  const width = (parts: string[]) => parts.reduce((n, p) => n + (p.includes('.') ? 2 : 1), 0);
  const missing = Math.max(0, 8 - width(left) - width(right));
  const groups = [...left, ...Array<string>(missing).fill('0'), ...right];
  const prefix = groups
    .slice(0, 4)
    .map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16).toString(16) : '0'));
  return `${prefix.join(':')}::/64`;
}

function normalizeIp(raw: string): string {
  let ip = raw.trim().toLowerCase();
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(ip);
  if (bracketed) {
    ip = bracketed[1];
  }
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(ip);
  if (withPort) {
    ip = withPort[1];
  }
  ip = ip.replace(/%.*$/, '');
  if (ip.startsWith('::ffff:') && isIPv4(ip.slice(7))) {
    return ip.slice(7);
  }
  if (isIPv4(ip)) {
    return ip;
  }
  if (isIPv6(ip)) {
    return ipv6Prefix(ip);
  }
  return ip || 'desconocida';
}

/**
 * Clave de cliente para los límites por IP. Solo confía en `X-Forwarded-For` si hay proxies de
 * confianza configurados: así nadie se salta el límite inventándose la cabecera.
 */
export function clientKey(
  remoteAddress: string | undefined,
  forwardedFor: string | string[] | undefined,
  trustProxyHops: number,
): string {
  let ip = remoteAddress ?? '';
  if (trustProxyHops > 0) {
    const chain = firstHeader(forwardedFor)
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);
    if (chain.length > 0) {
      ip = chain[Math.max(0, chain.length - trustProxyHops)];
    }
  }
  return normalizeIp(ip);
}

// ------------------------------------------------------------------ Limitadores

const PRUNE_EVERY_MS = 60_000;

/** Cubeta de fichas: `capacity` de ráfaga que se recarga a `perSecond`. */
export class TokenBucket {
  private readonly capacity: number;
  private readonly perMs: number;
  private tokens: number;
  private updatedAt: number;

  constructor(capacity: number, perSecond: number, now: number) {
    this.capacity = capacity;
    this.perMs = perSecond / 1000;
    this.tokens = capacity;
    this.updatedAt = now;
  }

  take(now: number): boolean {
    if (!Number.isFinite(this.capacity)) {
      return true;
    }
    this.refill(now);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** `true` si ya se recargó del todo (se puede olvidar sin cambiar nada). */
  isFull(now: number): boolean {
    this.refill(now);
    return this.tokens >= this.capacity;
  }

  private refill(now: number): void {
    if (now > this.updatedAt) {
      this.tokens = Math.min(this.capacity, this.tokens + (now - this.updatedAt) * this.perMs);
      this.updatedAt = now;
    }
  }
}

/** Una cubeta por clave (p. ej. por IP); olvida las que ya se recargaron. */
export class KeyedRateLimiter {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly capacity: number;
  private readonly perSecond: number;
  private readonly now: () => number;
  private lastPrune: number;

  constructor(capacity: number, perSecond: number, now: () => number = Date.now) {
    this.capacity = capacity;
    this.perSecond = perSecond;
    this.now = now;
    this.lastPrune = now();
  }

  get size(): number {
    return this.buckets.size;
  }

  take(key: string): boolean {
    if (!Number.isFinite(this.capacity)) {
      return true;
    }
    const now = this.now();
    this.prune(now);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.capacity, this.perSecond, now);
      this.buckets.set(key, bucket);
    }
    return bucket.take(now);
  }

  private prune(now: number): void {
    if (now - this.lastPrune < PRUNE_EVERY_MS) {
      return;
    }
    this.lastPrune = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.isFull(now)) {
        this.buckets.delete(key);
      }
    }
  }
}

export interface FailureLimiterOptions {
  maxFailures: number;
  windowMs: number;
  blockMs: number;
  maxBlockMs: number;
}

interface FailureRecord {
  count: number;
  windowStart: number;
  blockedUntil: number;
  /** Bloqueos seguidos: cada uno dura el doble que el anterior. */
  strikes: number;
}

/** Bloquea una clave tras demasiados fallos en una ventana, con bloqueos crecientes. */
export class FailureLimiter {
  private readonly records = new Map<string, FailureRecord>();
  private readonly options: FailureLimiterOptions;
  private readonly now: () => number;
  private lastPrune: number;

  constructor(options: FailureLimiterOptions, now: () => number = Date.now) {
    this.options = options;
    this.now = now;
    this.lastPrune = now();
  }

  get size(): number {
    return this.records.size;
  }

  private get enabled(): boolean {
    return Number.isFinite(this.options.maxFailures) && this.options.maxFailures > 0;
  }

  isBlocked(key: string): boolean {
    const record = this.records.get(key);
    return record !== undefined && record.blockedUntil > this.now();
  }

  fail(key: string): void {
    if (!this.enabled) {
      return;
    }
    const now = this.now();
    this.prune(now);
    const { maxFailures, windowMs, blockMs, maxBlockMs } = this.options;
    const record = this.records.get(key) ?? {
      count: 0,
      windowStart: now,
      blockedUntil: 0,
      strikes: 0,
    };
    if (record.strikes > 0 && now - record.blockedUntil >= maxBlockMs) {
      record.strikes = 0;
    }
    if (now - record.windowStart >= windowMs) {
      record.count = 0;
      record.windowStart = now;
    }
    record.count++;
    if (record.count >= maxFailures) {
      record.blockedUntil = now + Math.min(maxBlockMs, blockMs * 2 ** record.strikes);
      record.strikes++;
      record.count = 0;
      record.windowStart = now;
    }
    this.records.set(key, record);
  }

  private prune(now: number): void {
    if (now - this.lastPrune < PRUNE_EVERY_MS) {
      return;
    }
    this.lastPrune = now;
    const { windowMs, maxBlockMs } = this.options;
    for (const [key, record] of this.records) {
      const quiet = now - record.windowStart >= windowMs;
      const forgiven = record.strikes === 0 || now - record.blockedUntil >= maxBlockMs;
      if (record.blockedUntil <= now && quiet && forgiven) {
        this.records.delete(key);
      }
    }
  }
}

/** Conexiones abiertas por clave, con un tope por clave. */
export class ConnectionCounter {
  private readonly counts = new Map<string, number>();
  private readonly maxPerKey: number;

  constructor(maxPerKey: number) {
    this.maxPerKey = maxPerKey;
  }

  canAccept(key: string): boolean {
    return (this.counts.get(key) ?? 0) < this.maxPerKey;
  }

  add(key: string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  remove(key: string): void {
    const next = (this.counts.get(key) ?? 0) - 1;
    if (next > 0) {
      this.counts.set(key, next);
    } else {
      this.counts.delete(key);
    }
  }

  count(key: string): number {
    return this.counts.get(key) ?? 0;
  }
}
