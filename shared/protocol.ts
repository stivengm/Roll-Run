/**
 * Contrato compartido entre el cliente (Angular) y el servidor (Node + Socket.IO) de Roll&Run.
 *
 * Reglas para este archivo:
 * - No importa nada: lo consumen el navegador y Node (con type stripping) por igual.
 * - Solo sintaxis "borrable" de TypeScript (sin enums, namespaces ni parameter properties).
 */

// ---------------------------------------------------------------------------
// Configuración de la sala
// ---------------------------------------------------------------------------

/** `all`: la penitencia deja el score total en 0. `turn`: solo se pierden los puntos del turno. */
export type PenaltyMode = 'all' | 'turn';

export interface RoomSettings {
  /** Puntos necesarios para ganar (score máximo). */
  targetScore: number;
  /** Cara del dado que castiga (1 a 6). */
  penaltyNumber: number;
  penaltyMode: PenaltyMode;
  /** Cupo de jugadores de la sala. */
  maxPlayers: number;
}

export const SETTINGS_LIMITS = {
  targetScore: { min: 10, max: 500, step: 5 },
  penaltyNumber: { min: 1, max: 6 },
  maxPlayers: { min: 2, max: 8 },
} as const;

export const DEFAULT_SETTINGS: RoomSettings = {
  targetScore: 50,
  penaltyNumber: 1,
  penaltyMode: 'all',
  maxPlayers: 6,
};

export const PENALTY_MODE_LABELS: Record<PenaltyMode, { title: string; description: string }> = {
  all: {
    title: 'Pierde todo',
    description: 'Si sale la penitencia, el score total del jugador vuelve a 0.',
  },
  turn: {
    title: 'Solo el turno',
    description: 'Si sale la penitencia, el jugador pierde solo lo que sumó en ese turno.',
  },
};

// ---------------------------------------------------------------------------
// Jugadores y perfiles
// ---------------------------------------------------------------------------

export const NAME_LIMITS = { min: 2, max: 18 } as const;

/** Códigos de sala: 6 dígitos (se muestran como "882 · 109"). */
export const ROOM_CODE_LENGTH = 6;

export interface AvatarOption {
  id: string;
  /** Nombre del ícono de Material Symbols Rounded. */
  icon: string;
  /** Color base del avatar (gradiente glossy). */
  color: string;
  label: string;
}

export const AVATARS: readonly AvatarOption[] = [
  { id: 'bolt', icon: 'bolt', color: '#ffd700', label: 'Rayo' },
  { id: 'rocket', icon: 'rocket_launch', color: '#fd8b00', label: 'Cohete' },
  { id: 'robot', icon: 'smart_toy', color: '#00f1fe', label: 'Robot' },
  { id: 'skull', icon: 'skull', color: '#ff6b6b', label: 'Calavera' },
  { id: 'fire', icon: 'local_fire_department', color: '#ff8a3d', label: 'Fuego' },
  { id: 'diamond', icon: 'diamond', color: '#b18cff', label: 'Diamante' },
  { id: 'helmet', icon: 'sports_motorsports', color: '#74f5ff', label: 'Piloto' },
  { id: 'paw', icon: 'pets', color: '#ffb77d', label: 'Garra' },
  { id: 'star', icon: 'star', color: '#ffe16d', label: 'Estrella' },
  { id: 'ninja', icon: 'sports_martial_arts', color: '#ff7ab6', label: 'Ninja' },
  { id: 'gamepad', icon: 'sports_esports', color: '#7cffb2', label: 'Gamer' },
  { id: 'trophy', icon: 'emoji_events', color: '#f5c518', label: 'Campeón' },
];

export const DEFAULT_AVATAR_ID = AVATARS[0].id;

export interface PlayerProfile {
  name: string;
  avatar: string;
}

export interface PlayerStats {
  /** Lanzamientos realizados en la partida actual. */
  rolls: number;
  /** Veces que le salió la penitencia. */
  penalties: number;
  /** Mayor cantidad de puntos sumados en un solo turno. */
  bestTurn: number;
}

export interface PlayerView {
  id: string;
  name: string;
  avatar: string;
  score: number;
  connected: boolean;
  /** Epoch ms de ingreso a la sala. La lista `players` ya viene ordenada por este campo. */
  joinedAt: number;
  stats: PlayerStats;
}

// ---------------------------------------------------------------------------
// Estado de la sala / partida
// ---------------------------------------------------------------------------

export type RoomStatus = 'lobby' | 'playing' | 'finished';

/**
 * Sub-estado mientras `status === 'playing'`:
 * - `idle`: el jugador del turno puede lanzar o plantarse.
 * - `rolling`: el dado está girando (el valor aún no se revela).
 * - `penalty`: salió la penitencia; en breve el turno pasa solo al siguiente jugador.
 * - `won`: alguien alcanzó la meta; en breve la sala pasa a `finished`.
 */
export type GamePhase = 'idle' | 'rolling' | 'penalty' | 'won';

export interface TurnView {
  playerId: string;
  /** Contador global de turnos de la partida (empieza en 1). */
  number: number;
  /** Puntos sumados durante este turno. */
  points: number;
  /** Valores obtenidos en este turno, en orden (incluye la penitencia si salió). */
  rolls: number[];
  /** Epoch ms en que empezó el turno. */
  startedAt: number;
}

export interface RollView {
  /** Incremental por sala; sirve para detectar un lanzamiento nuevo en el cliente. */
  id: number;
  playerId: string;
  /** `null` mientras `phase === 'rolling'`. */
  value: number | null;
  isPenalty: boolean;
  /** Puntos que perdió el jugador si fue penitencia. */
  lostPoints: number;
  /** Score del jugador después de aplicar el resultado. */
  scoreAfter: number;
}

export interface WinnerView {
  id: string;
  name: string;
  avatar: string;
  score: number;
}

export type LogKind =
  | 'join'
  | 'leave'
  | 'kick'
  | 'host'
  | 'settings'
  | 'start'
  | 'roll'
  | 'penalty'
  | 'pass'
  | 'skip'
  | 'win'
  | 'reset'
  | 'cancel';

export interface LogEntry {
  id: number;
  at: number;
  kind: LogKind;
  playerId?: string;
  value?: number;
  /** Texto listo para mostrar, generado por el servidor en español. */
  text: string;
}

export const LOG_LIMIT = 30;

export interface RoomView {
  code: string;
  hostId: string;
  status: RoomStatus;
  phase: GamePhase;
  settings: RoomSettings;
  /** Ordenados por orden de ingreso: es también el orden de los turnos. */
  players: PlayerView[];
  turn: TurnView | null;
  lastRoll: RollView | null;
  winner: WinnerView | null;
  /** Número de partida jugada en esta sala (0 si aún no empieza la primera). */
  round: number;
  /** Últimos eventos (más reciente al final). Máximo `LOG_LIMIT`. */
  log: LogEntry[];
  serverTime: number;
}

// ---------------------------------------------------------------------------
// Tiempos (ms). El servidor los usa para secuenciar; el cliente para animar.
// ---------------------------------------------------------------------------

export const TIMINGS = {
  /** Duración del giro del dado antes de revelar el valor. */
  rollMs: 1400,
  /** Pausa mostrando la penitencia antes de pasar el turno automáticamente. */
  penaltyMs: 2400,
  /** Pausa celebrando la victoria antes de pasar a la pantalla final. */
  winMs: 2600,
  /** Si el jugador del turno está desconectado este tiempo, su turno se salta solo. */
  disconnectedTurnSkipMs: 20_000,
  /**
   * Si el anfitrión está desconectado este tiempo mientras otro jugador está conectado, el rol
   * pasa al primer conectado.
   */
  hostTransferMs: 30_000,
  /**
   * En el lobby, un jugador desconectado este tiempo puede perder su silla: si la sala se llena,
   * si alguien entra con su apodo o si la partida empieza. Antes de eso nadie sale por tiempo.
   */
  lobbyDisconnectRemoveMs: 60_000,
  /** Una sala sin jugadores conectados se elimina tras este tiempo. */
  emptyRoomTtlMs: 10 * 60_000,
} as const;

// ---------------------------------------------------------------------------
// Eventos Socket.IO
// ---------------------------------------------------------------------------

export type Ack<T = null> = { ok: true; data: T } | { ok: false; error: string };
export type AckFn<T = null> = (response: Ack<T>) => void;

export interface SessionInfo {
  code: string;
  playerId: string;
  /** Secreto para reconectarse a la misma silla tras recargar la página. */
  token: string;
}

export interface JoinResult {
  session: SessionInfo;
  room: RoomView;
}

/** Payload vacío para eventos sin datos (todos los eventos llevan payload + ack). */
export type EmptyPayload = Record<string, never>;

export interface ClientToServerEvents {
  'room:create': (
    payload: { profile: PlayerProfile; settings: RoomSettings },
    ack: AckFn<JoinResult>,
  ) => void;
  'room:join': (payload: { code: string; profile: PlayerProfile }, ack: AckFn<JoinResult>) => void;
  'room:rejoin': (payload: SessionInfo, ack: AckFn<JoinResult>) => void;
  'room:leave': (payload: EmptyPayload, ack: AckFn) => void;
  /** Solo anfitrión. */
  'room:kick': (payload: { playerId: string }, ack: AckFn) => void;
  /** Solo anfitrión y solo en el lobby. */
  'room:settings': (payload: { settings: RoomSettings }, ack: AckFn) => void;
  /** Solo anfitrión, en el lobby, con al menos 2 jugadores conectados. */
  'game:start': (payload: EmptyPayload, ack: AckFn) => void;
  /** Solo el jugador del turno con `phase === 'idle'`. */
  'game:roll': (payload: EmptyPayload, ack: AckFn) => void;
  /** Plantarse / pasar turno. Solo el jugador del turno, tras lanzar al menos una vez. */
  'game:pass': (payload: EmptyPayload, ack: AckFn) => void;
  /** Solo anfitrión: salta el turno de un jugador desconectado. */
  'game:skip': (payload: EmptyPayload, ack: AckFn) => void;
  /** Solo anfitrión, con la partida terminada: vuelve al lobby con los scores en 0. */
  'game:restart': (payload: EmptyPayload, ack: AckFn) => void;
}

export interface ServerToClientEvents {
  'room:state': (room: RoomView) => void;
  /** El anfitrión expulsó a este jugador (o la sala dejó de existir). */
  'room:kicked': (payload: { reason: string }) => void;
}

// ---------------------------------------------------------------------------
// Utilidades puras compartidas
// ---------------------------------------------------------------------------

export function formatRoomCode(code: string): string {
  return code.length === ROOM_CODE_LENGTH ? `${code.slice(0, 3)} · ${code.slice(3)}` : code;
}

export function findAvatar(id: string | null | undefined): AvatarOption {
  return AVATARS.find((a) => a.id === id) ?? AVATARS[0];
}

// Controles (C0/C1), formato invisible (zero-width, bidi), separadores de línea/párrafo y
// rellenos que se ven en blanco (Hangul, Braille, Khmer, CGJ).
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}͏ᅟᅠ឴឵⠀ㅤﾠ]/gu;
/** A partir de la 4.ª marca combinante seguida (texto "Zalgo"). */
const EXCESS_MARKS_RE = /(\p{M}{3})\p{M}+/gu;
/** Lo que no se ve por sí solo: marcas, ignorables (incluye selectores de variación) y espacios. */
export const NOT_VISIBLE_RE = /[\p{M}\p{Default_Ignorable_Code_Point}⠀\s]/gu;
const MEANINGFUL_RE = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;

/**
 * Quita caracteres invisibles, colapsa espacios, deja como mucho 3 marcas combinantes seguidas
 * y recorta a `NAME_LIMITS.max` caracteres. El servidor aplica esta misma limpieza.
 */
export function cleanName(raw: string): string {
  const collapsed = raw
    .normalize('NFC')
    .replace(INVISIBLE_RE, '')
    .replace(/\s+/g, ' ')
    .replace(EXCESS_MARKS_RE, '$1')
    .trim();
  return Array.from(collapsed).slice(0, NAME_LIMITS.max).join('').trim();
}

/** Motivo por el que un apodo ya limpio (`cleanName`) no sirve, o `null` si es válido. */
export function nameError(name: string): string | null {
  if (Array.from(name).length < NAME_LIMITS.min) {
    return `El apodo debe tener al menos ${NAME_LIMITS.min} caracteres.`;
  }
  const visible = Array.from(name.normalize('NFD').replace(NOT_VISIBLE_RE, ''));
  if (visible.length < NAME_LIMITS.min || !visible.some((ch) => MEANINGFUL_RE.test(ch))) {
    return `El apodo debe tener al menos ${NAME_LIMITS.min} letras, números o emojis visibles.`;
  }
  return null;
}
