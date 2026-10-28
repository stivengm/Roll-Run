import {
  AVATARS,
  cleanName,
  DEFAULT_AVATAR_ID,
  DEFAULT_SETTINGS,
  nameError,
  NOT_VISIBLE_RE,
  ROOM_CODE_LENGTH,
  SETTINGS_LIMITS,
} from '../../shared/protocol.ts';
import type {
  PenaltyMode,
  PlayerProfile,
  RoomSettings,
  SessionInfo,
} from '../../shared/protocol.ts';

/** Resultado de una validación: el valor saneado o un mensaje de error para el usuario. */
export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

/** Longitud máxima aceptada para ids y tokens que llegan del cliente. */
const MAX_ID_LENGTH = 64;

/** La limpieza del apodo vive en el contrato: el cliente valida con la misma regla. */
export { cleanName };

const ROOM_CODE_RE = new RegExp(`^\\d{${ROOM_CODE_LENGTH}}$`);

/**
 * Letras cirílicas, griegas y armenias que se ven igual que una latina. Solo se usan para
 * comparar apodos: el nombre que se muestra no cambia.
 */
// prettier-ignore
const CONFUSABLES: Record<string, string> = {
  // Cirílico
  А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X',
  У: 'Y', Ү: 'Y', Ѕ: 'S', І: 'I', Ӏ: 'I', Ј: 'J', Ԛ: 'Q', Ԝ: 'W',
  а: 'a', в: 'b', е: 'e', к: 'k', м: 'm', н: 'h', о: 'o', р: 'p', с: 'c', т: 't', х: 'x',
  у: 'y', ү: 'y', ѕ: 's', і: 'i', ӏ: 'l', ј: 'j', һ: 'h', ԁ: 'd', ԛ: 'q', ԝ: 'w',
  // Griego
  Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P',
  Τ: 'T', Υ: 'Y', Χ: 'X',
  α: 'a', β: 'b', ε: 'e', ι: 'i', κ: 'k', ν: 'v', ο: 'o', ρ: 'p', τ: 't', υ: 'u', χ: 'x',
  // Otros
  ı: 'i', ȷ: 'j', օ: 'o', ս: 'u',
};
const CONFUSABLE_RE = new RegExp(`[${Object.keys(CONFUSABLES).join('')}]`, 'gu');

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isRoomCode(value: unknown): value is string {
  return typeof value === 'string' && ROOM_CODE_RE.test(value);
}

/** Ids de jugador y tokens: cadenas cortas sin espacios. */
export function isId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_ID_LENGTH &&
    /^[\w-]+$/.test(value)
  );
}

/**
 * Clave para comparar apodos sin distinguir mayúsculas, acentos, espacios, formas de ancho
 * completo o estilizadas (NFKD) ni letras de otros alfabetos que se ven iguales.
 */
export function nameKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(NOT_VISIBLE_RE, '')
    .replace(CONFUSABLE_RE, (ch) => CONFUSABLES[ch] ?? ch)
    .toLocaleLowerCase('es');
}

export function sanitizeName(raw: unknown): Validated<string> {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'Escribe un apodo para jugar.' };
  }
  const name = cleanName(raw);
  const error = nameError(name);
  return error ? { ok: false, error } : { ok: true, value: name };
}

export function sanitizeAvatar(raw: unknown): string {
  return typeof raw === 'string' && AVATARS.some((a) => a.id === raw) ? raw : DEFAULT_AVATAR_ID;
}

export function sanitizeProfile(raw: unknown): Validated<PlayerProfile> {
  if (!isPlainObject(raw)) {
    return { ok: false, error: 'Perfil de jugador inválido.' };
  }
  const name = sanitizeName(raw['name']);
  if (!name.ok) {
    return name;
  }
  return { ok: true, value: { name: name.value, avatar: sanitizeAvatar(raw['avatar']) } };
}

function toInt(value: unknown, fallback: number): number {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Normaliza la configuración de la sala. Nunca falla: lo inválido toma el valor por defecto. */
export function sanitizeSettings(raw: unknown): RoomSettings {
  if (!isPlainObject(raw)) {
    return { ...DEFAULT_SETTINGS };
  }
  const { targetScore, penaltyNumber, maxPlayers } = SETTINGS_LIMITS;

  const target = clamp(
    toInt(raw['targetScore'], DEFAULT_SETTINGS.targetScore),
    targetScore.min,
    targetScore.max,
  );
  const stepped = clamp(
    Math.round(target / targetScore.step) * targetScore.step,
    targetScore.min,
    targetScore.max,
  );
  const mode: PenaltyMode = raw['penaltyMode'] === 'turn' ? 'turn' : 'all';

  return {
    targetScore: stepped,
    penaltyNumber: clamp(
      toInt(raw['penaltyNumber'], DEFAULT_SETTINGS.penaltyNumber),
      penaltyNumber.min,
      penaltyNumber.max,
    ),
    penaltyMode: mode,
    maxPlayers: clamp(
      toInt(raw['maxPlayers'], DEFAULT_SETTINGS.maxPlayers),
      maxPlayers.min,
      maxPlayers.max,
    ),
  };
}

export function parseSession(raw: unknown): SessionInfo | null {
  if (!isPlainObject(raw)) {
    return null;
  }
  const { code, playerId, token } = raw;
  return isRoomCode(code) && isId(playerId) && isId(token) ? { code, playerId, token } : null;
}

/** Valor de dado válido (entero 1..6) o `null`. */
export function asDieValue(value: unknown): number | null {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 6
    ? (value as number)
    : null;
}
