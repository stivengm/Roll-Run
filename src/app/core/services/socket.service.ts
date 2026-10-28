import { Injectable, signal } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { environment } from '../../../environments/environment';
import type {
  Ack,
  ClientToServerEvents,
  ServerToClientEvents,
} from '../../../../shared/protocol';

export type ConnectionStatus = 'connecting' | 'online' | 'offline';

type GameSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type EventName = keyof ClientToServerEvents;
type PayloadOf<E extends EventName> = Parameters<ClientToServerEvents[E]>[0];
type AckDataOf<E extends EventName> =
  Parameters<ClientToServerEvents[E]>[1] extends (response: Ack<infer T>) => void ? T : never;

const ACK_TIMEOUT_MS = 8000;
const OFFLINE_MESSAGE = 'Sin conexión con el servidor. Reintentando…';
const NO_RESPONSE_MESSAGE = 'El servidor no respondió. Intenta de nuevo.';
/** Mismo texto que `INTERNAL_ERROR` del servidor: un fallo puntual, no un rechazo. */
const INTERNAL_ERROR_MESSAGE = 'Error interno del servidor';

/** El servidor respondió y rechazó la petición (ack `ok: false`). */
export class ServerError extends Error {
  override readonly name = 'ServerError';
  /** `true` si fue un error interno: reintentar puede funcionar. */
  readonly transient: boolean;

  constructor(message: string) {
    super(message);
    this.transient = message === INTERNAL_ERROR_MESSAGE;
  }
}

/** La petición no llegó al servidor o su respuesta se perdió (sin conexión, timeout, corte). */
export class TransportError extends Error {
  override readonly name = 'TransportError';
}

/** Rechazo definitivo del servidor (no un fallo de red ni un error interno). */
export function isRejection(err: unknown): err is ServerError {
  return err instanceof ServerError && !err.transient;
}

/** Lo que `sendRequest` usa de un socket de Socket.IO (permite probarlo sin red). */
export interface AckSocket {
  readonly connected: boolean;
  readonly sendBuffer: unknown[];
  timeout(ms: number): { emitWithAck(event: string, payload: unknown): Promise<unknown> };
}

/**
 * Emite un evento y espera su ack. Nunca deja la petición en el buffer de Socket.IO: al
 * reconectar se enviaría antes del `room:rejoin`, en un socket todavía sin silla.
 */
export async function sendRequest<T>(
  socket: AckSocket,
  event: string,
  payload: unknown,
): Promise<T> {
  if (!socket.connected) {
    throw new TransportError(OFFLINE_MESSAGE);
  }
  const buffered = socket.sendBuffer.length;
  const pending = socket.timeout(ACK_TIMEOUT_MS).emitWithAck(event, payload) as Promise<Ack<T>>;
  // Conectado "en papel" pero con el ping vencido (p. ej. al volver la app del fondo en móvil).
  if (socket.sendBuffer.length > buffered) {
    socket.sendBuffer.splice(buffered);
    pending.catch(() => undefined);
    throw new TransportError(OFFLINE_MESSAGE);
  }
  let response: Ack<T>;
  try {
    response = await pending;
  } catch {
    throw new TransportError(socket.connected ? NO_RESPONSE_MESSAGE : OFFLINE_MESSAGE);
  }
  if (!response.ok) {
    throw new ServerError(response.error);
  }
  return response.data;
}

/**
 * Envoltura delgada de Socket.IO: una sola conexión para toda la app,
 * estado de conexión como signal y `request()` tipado con ack + timeout.
 */
@Injectable({ providedIn: 'root' })
export class SocketService {
  readonly status = signal<ConnectionStatus>('connecting');

  private readonly socket: GameSocket = io(environment.socketUrl || undefined, {
    autoConnect: true,
    reconnection: true,
    reconnectionDelay: 600,
    reconnectionDelayMax: 4000,
  });

  constructor() {
    this.socket.on('connect', () => this.status.set('online'));
    this.socket.on('disconnect', () => this.status.set('offline'));
    this.socket.on('connect_error', () => this.status.set('offline'));
    this.socket.io.on('reconnect_attempt', () => this.status.set('connecting'));
  }

  get connected(): boolean {
    return this.socket.connected;
  }

  /**
   * Emite un evento y espera el ack del servidor.
   * Lanza `ServerError` si el servidor lo rechaza y `TransportError` si no hay respuesta.
   */
  request<E extends EventName>(event: E, payload: PayloadOf<E>): Promise<AckDataOf<E>> {
    // El tipado genérico de emitWithAck no resuelve bien con eventos parametrizados.
    return sendRequest<AckDataOf<E>>(this.socket as unknown as AckSocket, event, payload);
  }

  on<E extends keyof ServerToClientEvents>(event: E, handler: ServerToClientEvents[E]): () => void {
    // Socket.IO tipa `on` con sobrecargas reservadas; el cast mantiene el handler tipado hacia afuera.
    this.socket.on(event, handler as never);
    return () => this.socket.off(event, handler as never);
  }

  /** Se dispara en cada (re)conexión exitosa. */
  onConnect(handler: () => void): () => void {
    this.socket.on('connect', handler);
    return () => this.socket.off('connect', handler);
  }

  /** Se dispara cada vez que se pierde la conexión. */
  onDisconnect(handler: () => void): () => void {
    this.socket.on('disconnect', handler);
    return () => this.socket.off('disconnect', handler);
  }
}
