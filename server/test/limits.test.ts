import { describe, expect, it } from 'vitest';
import {
  ConnectionCounter,
  DEFAULT_LIMITS,
  FailureLimiter,
  KeyedRateLimiter,
  TokenBucket,
  clientKey,
  limitsFromEnv,
  resolveLimits,
} from '../src/limits.ts';

function clock(start = 1_700_000_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => (now += ms),
  };
}

describe('clientKey', () => {
  it('normaliza IPv4, IPv4 mapeada y puertos', () => {
    expect(clientKey('127.0.0.1', undefined, 0)).toBe('127.0.0.1');
    expect(clientKey('::ffff:10.1.2.3', undefined, 0)).toBe('10.1.2.3');
    expect(clientKey(undefined, undefined, 0)).toBe('desconocida');
    expect(clientKey('10.0.0.1', '1.2.3.4:5678', 1)).toBe('1.2.3.4');
  });

  it('agrupa IPv6 por su prefijo /64', () => {
    const a = clientKey('2001:db8:aa:bb:1::1', undefined, 0);
    const b = clientKey('2001:0db8:00aa:00bb:ffff:1:2:3', undefined, 0);
    expect(a).toBe('2001:db8:aa:bb::/64');
    expect(b).toBe(a);
    expect(clientKey('::1', undefined, 0)).toBe('0:0:0:0::/64');
    expect(clientKey('[2001:db8::1]:443', undefined, 0)).toBe('2001:db8:0:0::/64');
  });

  it('ignora X-Forwarded-For sin proxies de confianza y lo lee desde la derecha con ellos', () => {
    expect(clientKey('10.0.0.9', '6.6.6.6', 0)).toBe('10.0.0.9');
    // El cliente puede inventarse las primeras entradas; la última la puso el proxy.
    expect(clientKey('10.0.0.9', '6.6.6.6, 203.0.113.7', 1)).toBe('203.0.113.7');
    expect(clientKey('10.0.0.9', ['6.6.6.6, 203.0.113.7', '198.51.100.2'], 2)).toBe(
      '203.0.113.7',
    );
    expect(clientKey('10.0.0.9', '203.0.113.7', 3)).toBe('203.0.113.7');
    expect(clientKey('10.0.0.9', '', 1)).toBe('10.0.0.9');
  });
});

describe('límites configurables', () => {
  it('resolveLimits solo acepta números >= 0 (Infinity desactiva)', () => {
    const limits = resolveLimits({ maxRooms: 5, joinFailures: Infinity, eventBurst: -1 });
    expect(limits.maxRooms).toBe(5);
    expect(limits.joinFailures).toBe(Infinity);
    expect(limits.eventBurst).toBe(DEFAULT_LIMITS.eventBurst);
  });

  it('limitsFromEnv lee MAX_ROOMS, MAX_CONNECTIONS(_PER_IP) y TRUST_PROXY', () => {
    expect(limitsFromEnv({})).toEqual({});
    expect(
      limitsFromEnv({
        MAX_ROOMS: '100',
        MAX_CONNECTIONS: 'mucho',
        MAX_CONNECTIONS_PER_IP: '7',
        TRUST_PROXY: 'true',
      }),
    ).toEqual({ maxRooms: 100, maxConnectionsPerIp: 7, trustProxyHops: 1 });
    expect(limitsFromEnv({ TRUST_PROXY: '2' })).toEqual({ trustProxyHops: 2 });
    expect(limitsFromEnv({ TRUST_PROXY: 'no' })).toEqual({});
  });
});

describe('limitadores', () => {
  it('TokenBucket permite la ráfaga y luego recarga al ritmo indicado', () => {
    const c = clock();
    const bucket = new TokenBucket(3, 2, c.now());
    expect([1, 2, 3, 4].map(() => bucket.take(c.now()))).toEqual([true, true, true, false]);
    c.advance(499);
    expect(bucket.take(c.now())).toBe(false);
    c.advance(1);
    expect(bucket.take(c.now())).toBe(true);
    expect(new TokenBucket(Infinity, 0, c.now()).take(c.now())).toBe(true);
  });

  it('KeyedRateLimiter separa por clave y olvida las cubetas recargadas', () => {
    const c = clock();
    const limiter = new KeyedRateLimiter(2, 2 / 60, c.now);
    expect([limiter.take('a'), limiter.take('a'), limiter.take('a')]).toEqual([true, true, false]);
    expect(limiter.take('b')).toBe(true);
    expect(limiter.size).toBe(2);
    c.advance(61_000);
    expect(limiter.take('c')).toBe(true);
    // 'a' y 'b' ya se habían recargado: solo queda 'c'.
    expect(limiter.size).toBe(1);
  });

  it('FailureLimiter bloquea tras N fallos, con bloqueos que se duplican y caducan', () => {
    const c = clock();
    const limiter = new FailureLimiter(
      { maxFailures: 3, windowMs: 60_000, blockMs: 10_000, maxBlockMs: 25_000 },
      c.now,
    );
    limiter.fail('ip');
    limiter.fail('ip');
    expect(limiter.isBlocked('ip')).toBe(false);
    limiter.fail('ip');
    expect(limiter.isBlocked('ip')).toBe(true);
    expect(limiter.isBlocked('otra')).toBe(false);
    c.advance(10_000);
    expect(limiter.isBlocked('ip')).toBe(false);

    // Segundo bloqueo: el doble.
    for (let i = 0; i < 3; i++) limiter.fail('ip');
    c.advance(19_999);
    expect(limiter.isBlocked('ip')).toBe(true);
    c.advance(1);
    expect(limiter.isBlocked('ip')).toBe(false);

    // Tercero: tope en maxBlockMs.
    for (let i = 0; i < 3; i++) limiter.fail('ip');
    c.advance(25_000);
    expect(limiter.isBlocked('ip')).toBe(false);

    // Fallos espaciados (fuera de la ventana) no bloquean.
    c.advance(10 * 60_000);
    for (let i = 0; i < 5; i++) {
      limiter.fail('lento');
      c.advance(30_000);
    }
    expect(limiter.isBlocked('lento')).toBe(false);
  });

  it('FailureLimiter desactivado no bloquea nunca', () => {
    const limiter = new FailureLimiter({
      maxFailures: Infinity,
      windowMs: 1,
      blockMs: 1,
      maxBlockMs: 1,
    });
    for (let i = 0; i < 100; i++) limiter.fail('ip');
    expect(limiter.isBlocked('ip')).toBe(false);
    expect(limiter.size).toBe(0);
  });

  it('ConnectionCounter cuenta por clave con tope', () => {
    const counter = new ConnectionCounter(2);
    counter.add('a');
    expect(counter.canAccept('a')).toBe(true);
    counter.add('a');
    expect(counter.canAccept('a')).toBe(false);
    expect(counter.canAccept('b')).toBe(true);
    counter.remove('a');
    counter.remove('a');
    expect(counter.count('a')).toBe(0);
    expect(counter.canAccept('a')).toBe(true);
  });
});
