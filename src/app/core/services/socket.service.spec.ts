import {
  isRejection,
  sendRequest,
  ServerError,
  TransportError,
  type AckSocket,
} from './socket.service';

/** Socket mínimo: `emit` decide si el paquete sale o se queda en el buffer (sin conexión real). */
class FakeAckSocket implements AckSocket {
  connected = true;
  /** Simula Socket.IO con el ping vencido: `connected` sigue en true pero el emit va al buffer. */
  pingExpired = false;
  readonly sendBuffer: unknown[] = [];
  readonly emitted: { event: string; payload: unknown }[] = [];
  respond: () => Promise<unknown> = () => Promise.resolve({ ok: true, data: null });

  timeout(): { emitWithAck(event: string, payload: unknown): Promise<unknown> } {
    return {
      emitWithAck: (event, payload) => {
        if (this.pingExpired) {
          this.sendBuffer.push({ event, payload });
          return new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5));
        }
        this.emitted.push({ event, payload });
        return this.respond();
      },
    };
  }
}

describe('sendRequest', () => {
  let socket: FakeAckSocket;

  beforeEach(() => (socket = new FakeAckSocket()));

  it('devuelve los datos del ack', async () => {
    socket.respond = () => Promise.resolve({ ok: true, data: { code: '882109' } });
    await expect(sendRequest(socket, 'room:join', { code: '882109' })).resolves.toEqual({
      code: '882109',
    });
    expect(socket.emitted).toEqual([{ event: 'room:join', payload: { code: '882109' } }]);
  });

  it('sin conexión falla al instante y no emite nada', async () => {
    socket.connected = false;
    const err = await sendRequest(socket, 'game:roll', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    expect((err as Error).message).toBe('Sin conexión con el servidor. Reintentando…');
    expect(socket.emitted).toEqual([]);
    expect(socket.sendBuffer).toEqual([]);
  });

  it('si el paquete queda en el buffer (ping vencido) lo retira y falla', async () => {
    socket.pingExpired = true;
    socket.sendBuffer.push('paquete previo');
    const err = await sendRequest(socket, 'game:roll', {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransportError);
    // Al reconectar no se enviará antes del room:rejoin.
    expect(socket.sendBuffer).toEqual(['paquete previo']);
  });

  it('distingue el rechazo del servidor de un error interno', async () => {
    socket.respond = () => Promise.resolve({ ok: false, error: 'La sala ya no existe.' });
    const rejected = await sendRequest(socket, 'room:rejoin', {}).catch((e: unknown) => e);
    expect(rejected).toBeInstanceOf(ServerError);
    expect((rejected as Error).message).toBe('La sala ya no existe.');
    expect(isRejection(rejected)).toBe(true);

    socket.respond = () => Promise.resolve({ ok: false, error: 'Error interno del servidor' });
    const internal = await sendRequest(socket, 'room:rejoin', {}).catch((e: unknown) => e);
    expect(internal).toBeInstanceOf(ServerError);
    expect(isRejection(internal)).toBe(false);
  });

  it('un timeout o un corte con el ack pendiente es un error de transporte', async () => {
    socket.respond = () => Promise.reject(new Error('operation has timed out'));
    const timeout = await sendRequest(socket, 'game:pass', {}).catch((e: unknown) => e);
    expect(timeout).toBeInstanceOf(TransportError);
    expect((timeout as Error).message).toBe('El servidor no respondió. Intenta de nuevo.');
    expect(isRejection(timeout)).toBe(false);

    socket.respond = () => {
      socket.connected = false;
      return Promise.reject(new Error('socket has been disconnected'));
    };
    const cut = await sendRequest(socket, 'game:pass', {}).catch((e: unknown) => e);
    expect((cut as Error).message).toBe('Sin conexión con el servidor. Reintentando…');
  });
});
