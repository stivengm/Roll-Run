import { describe, expect, it } from 'vitest';
import { DEFAULT_AVATAR_ID, DEFAULT_SETTINGS, NAME_LIMITS } from '../../shared/protocol.ts';
import {
  asDieValue,
  cleanName,
  isId,
  isRoomCode,
  nameKey,
  parseSession,
  sanitizeProfile,
  sanitizeSettings,
} from '../src/validation.ts';

describe('sanitizeProfile', () => {
  it('colapsa espacios, quita caracteres de control/invisibles y recorta', () => {
    expect(sanitizeProfile({ name: '  Ana \t\n  María  ', avatar: 'rocket' })).toEqual({
      ok: true,
      value: { name: 'Ana María', avatar: 'rocket' },
    });
    expect(sanitizeProfile({ name: 'Bo\u0000b\u200B\u202Ey', avatar: 'robot' })).toEqual({
      ok: true,
      value: { name: 'Boby', avatar: 'robot' },
    });
  });

  it('recorta a NAME_LIMITS.max caracteres', () => {
    const result = sanitizeProfile({ name: 'x'.repeat(40), avatar: 'bolt' });
    expect(result.ok && result.value.name.length).toBe(NAME_LIMITS.max);
  });

  it('usa el avatar por defecto si no existe', () => {
    expect(sanitizeProfile({ name: 'Ana', avatar: 'nope' })).toEqual({
      ok: true,
      value: { name: 'Ana', avatar: DEFAULT_AVATAR_ID },
    });
    expect(sanitizeProfile({ name: 'Ana' })).toMatchObject({
      ok: true,
      value: { avatar: DEFAULT_AVATAR_ID },
    });
  });

  it('rechaza nombres cortos, vacíos o de otro tipo con mensaje en español', () => {
    expect(sanitizeProfile({ name: ' a ', avatar: 'bolt' })).toEqual({
      ok: false,
      error: `El apodo debe tener al menos ${NAME_LIMITS.min} caracteres.`,
    });
    expect(sanitizeProfile({ name: '\u200B\u200B', avatar: 'bolt' }).ok).toBe(false);
    expect(sanitizeProfile({ name: 42 })).toEqual({
      ok: false,
      error: 'Escribe un apodo para jugar.',
    });
    expect(sanitizeProfile(null)).toEqual({ ok: false, error: 'Perfil de jugador inválido.' });
    expect(sanitizeProfile('Ana').ok).toBe(false);
    expect(sanitizeProfile(['Ana']).ok).toBe(false);
  });
});

describe('apodos engañosos', () => {
  const ok = (name: string) => sanitizeProfile({ name, avatar: 'bolt' }).ok;

  it('rechaza apodos que se ven en blanco o sin nada legible', () => {
    for (const blank of ['\u3164\u3164', '\u2800\u2800\u2800', '\u115F\u1160', '\uFFA0\uFFA0']) {
      expect(ok(blank), JSON.stringify(blank)).toBe(false);
    }
    expect(sanitizeProfile({ name: '\u0301\u0301\u0301', avatar: 'bolt' })).toEqual({
      ok: false,
      error: `El apodo debe tener al menos ${NAME_LIMITS.min} letras, números o emojis visibles.`,
    });
    expect(ok('!!')).toBe(false);
    expect(ok('A' + '\u0336'.repeat(17))).toBe(false);
  });

  it('acepta nombres reales de cualquier alfabeto y apodos de emojis', () => {
    for (const name of ['Ana', 'José', '😀😀', '🎲🎲', '李明', 'Nguyễn', 'Ñandú', 'Иван', 'Ζωή', '42']) {
      expect(ok(name), name).toBe(true);
    }
  });

  it('recorta el texto "Zalgo" a 3 marcas seguidas sin tocar los acentos', () => {
    const zalgo = cleanName('Ana' + '\u0336'.repeat(17));
    expect(zalgo).toBe('Ana' + '\u0336'.repeat(3));
    expect(cleanName('Nguye\u0302\u0303n')).toBe('Nguyễn');
  });

  it('nameKey iguala homoglifos, ancho completo y letras estilizadas', () => {
    const key = nameKey('Ana');
    for (const fake of ['\u0410na', 'An\u0430', '\u0391na', 'ＡＮＡ', '𝐀𝐧𝐚', 'ᴬⁿᵃ', 'A\u200Bna', 'A n a']) {
      expect(nameKey(fake), JSON.stringify(fake)).toBe(key);
    }
    expect(nameKey('Lia')).not.toBe(nameKey('Ila'));
    expect(nameKey('Việt')).toBe('viet');
  });
});

describe('sanitizeSettings', () => {
  it('devuelve los valores por defecto si no es un objeto', () => {
    expect(sanitizeSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings('hola')).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings([1, 2])).toEqual(DEFAULT_SETTINGS);
    expect(sanitizeSettings(null)).not.toBe(DEFAULT_SETTINGS);
  });

  it('acota a SETTINGS_LIMITS y redondea la meta al paso', () => {
    expect(
      sanitizeSettings({ targetScore: 9999, penaltyNumber: 0, penaltyMode: 'turn', maxPlayers: 1 }),
    ).toEqual({ targetScore: 500, penaltyNumber: 1, penaltyMode: 'turn', maxPlayers: 2 });
    expect(
      sanitizeSettings({ targetScore: -5, penaltyNumber: 7, penaltyMode: 'x', maxPlayers: 99 }),
    ).toEqual({ targetScore: 10, penaltyNumber: 6, penaltyMode: 'all', maxPlayers: 8 });
    expect(sanitizeSettings({ targetScore: 52 }).targetScore).toBe(50);
    expect(sanitizeSettings({ targetScore: 53 }).targetScore).toBe(55);
    expect(sanitizeSettings({ penaltyNumber: 3.6 }).penaltyNumber).toBe(4);
  });

  it('acepta números como texto y usa el valor por defecto con basura', () => {
    expect(sanitizeSettings({ targetScore: '100', maxPlayers: '4' })).toMatchObject({
      targetScore: 100,
      maxPlayers: 4,
    });
    expect(
      sanitizeSettings({ targetScore: 'abc', penaltyNumber: NaN, maxPlayers: Infinity }),
    ).toEqual({ ...DEFAULT_SETTINGS });
  });
});

describe('códigos, ids y sesiones', () => {
  it('isRoomCode exige exactamente 6 dígitos', () => {
    expect(isRoomCode('123456')).toBe(true);
    expect(isRoomCode('012345')).toBe(true);
    expect(isRoomCode('12345')).toBe(false);
    expect(isRoomCode('1234567')).toBe(false);
    expect(isRoomCode('12a456')).toBe(false);
    expect(isRoomCode(123456)).toBe(false);
  });

  it('isId acepta ids cortos sin caracteres raros', () => {
    expect(isId('0b6f7c2e-1a2b-4c3d-9e8f-001122334455')).toBe(true);
    expect(isId('')).toBe(false);
    expect(isId('a b')).toBe(false);
    expect(isId('x'.repeat(65))).toBe(false);
    expect(isId({})).toBe(false);
  });

  it('parseSession valida la forma completa', () => {
    const session = { code: '123456', playerId: 'abc-123', token: 'f'.repeat(32) };
    expect(parseSession(session)).toEqual(session);
    expect(parseSession({ ...session, extra: 1 })).toEqual(session);
    expect(parseSession({ ...session, code: '12' })).toBeNull();
    expect(parseSession({ ...session, token: 5 })).toBeNull();
    expect(parseSession('x')).toBeNull();
  });

  it('nameKey ignora mayúsculas, acentos y espacios', () => {
    expect(nameKey('Ána  María')).toBe(nameKey('ana maria'));
    expect(nameKey('JuanPablo')).toBe(nameKey('juan pablo'));
    expect(nameKey('Ana')).not.toBe(nameKey('Ano'));
  });

  it('asDieValue solo acepta enteros de 1 a 6', () => {
    expect([1, 6].map(asDieValue)).toEqual([1, 6]);
    expect([0, 7, 2.5, '3', NaN].map(asDieValue)).toEqual([null, null, null, null, null]);
  });
});
