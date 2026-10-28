import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import {
  provideRouter,
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
} from '@angular/router';
import {
  DEFAULT_SETTINGS,
  type LogEntry,
  type PlayerView,
  type RoomView,
  type SessionInfo,
} from '../../../../shared/protocol';
import { confirmLeaveGuard } from '../../core/guards/leave.guard';
import { GameStore } from '../../core/services/game.store';
import { ProfileService } from '../../core/services/profile.service';
import { SocketService, type ConnectionStatus } from '../../core/services/socket.service';
import { ToastService } from '../../core/services/toast.service';
import { Room } from './room';

class FakeSocket {
  readonly status = signal<ConnectionStatus>('online');
  readonly connected = true;
  readonly request = vi.fn<(event: string, payload: unknown) => Promise<unknown>>();
  private readonly handlers = new Map<string, (payload: never) => void>();

  on(event: string, handler: (payload: never) => void): () => void {
    this.handlers.set(event, handler);
    return () => this.handlers.delete(event);
  }

  onConnect(): () => void {
    return () => undefined;
  }

  onDisconnect(): () => void {
    return () => undefined;
  }

  emit(event: string, payload: unknown): void {
    this.handlers.get(event)?.(payload as never);
  }
}

const SESSION: SessionInfo = { code: '882109', playerId: 'p1', token: 't1' };

function player(id: string, name: string): PlayerView {
  return {
    id,
    name,
    avatar: 'bolt',
    score: 0,
    connected: true,
    joinedAt: 0,
    stats: { rolls: 0, penalties: 0, bestTurn: 0 },
  };
}

function room(patch: Partial<RoomView> = {}): RoomView {
  return {
    code: SESSION.code,
    hostId: 'p1',
    status: 'lobby',
    phase: 'idle',
    settings: DEFAULT_SETTINGS,
    players: [player('p1', 'Ana'), player('p2', 'Bea')],
    turn: null,
    lastRoll: null,
    winner: null,
    round: 1,
    log: [],
    serverTime: 0,
    ...patch,
  };
}

function entry(id: number, kind: LogEntry['kind'], text: string, playerId?: string): LogEntry {
  return { id, at: 0, kind, text, playerId };
}

const START_LOG = [entry(1, 'join', 'Bea entró a la sala', 'p2'), entry(2, 'start', 'Empieza')];

describe('Room', () => {
  let socket: FakeSocket;
  let store: GameStore;
  let fixture: ComponentFixture<Room>;

  const toasts = () => TestBed.inject(ToastService).toasts().map((t) => t.text);

  async function push(state: RoomView): Promise<void> {
    socket.emit('room:state', state);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  beforeEach(async () => {
    sessionStorage.clear();
    localStorage.clear();
    vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    socket = new FakeSocket();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: SocketService, useValue: socket }],
    });
    // Solo interesa la lógica del contenedor, no las pantallas hijas.
    TestBed.overrideComponent(Room, { set: { template: '', imports: [] } });
    TestBed.inject(ProfileService).setName('Ana');
    store = TestBed.inject(GameStore);
    socket.request.mockResolvedValue({ session: SESSION, room: room({ log: START_LOG }) });
    await store.joinRoom(SESSION.code);

    fixture = TestBed.createComponent(Room);
    fixture.componentRef.setInput('code', SESSION.code);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(() => vi.restoreAllMocks());

  describe('salida con el atrás del navegador', () => {
    it('con sesión en la sala cancela la navegación y abre la confirmación', () => {
      const component = fixture.componentInstance;
      const guard = () =>
        TestBed.runInInjectionContext(() =>
          confirmLeaveGuard(
            component,
            {} as ActivatedRouteSnapshot,
            {} as RouterStateSnapshot,
            {} as RouterStateSnapshot,
          ),
        );

      expect(guard()).toBe(false);
      expect(component['leaveOpen']()).toBe(true);

      // Un segundo "atrás" cierra la hoja y sigue en la sala.
      expect(guard()).toBe(false);
      expect(component['leaveOpen']()).toBe(false);
    });

    it('deja salir sin pedir nada cuando ya no hay sesión (salió, expulsado, sala cerrada)', async () => {
      socket.request.mockResolvedValue(null);
      await store.leave();

      expect(fixture.componentInstance.canLeave()).toBe(true);
      expect(fixture.componentInstance['leaveOpen']()).toBe(false);
    });
  });

  describe('partida cancelada por falta de jugadores', () => {
    it('avisa a quien se queda de quién salió y de la cancelación', async () => {
      await push(room({ status: 'playing', log: START_LOG }));
      expect(toasts()).toEqual([]);

      await push(
        room({
          status: 'lobby',
          players: [player('p1', 'Ana')],
          log: [
            ...START_LOG,
            entry(3, 'leave', 'Bea salió de la sala', 'p2'),
            entry(4, 'cancel', 'Partida cancelada: no hay suficientes jugadores'),
          ],
        }),
      );

      expect(toasts()).toEqual([
        'Bea salió de la sala. Partida cancelada: no hay suficientes jugadores.',
      ]);
    });

    it('si salió el anfitrión, avisa también del nuevo rol', async () => {
      await push(room({ status: 'playing', hostId: 'p2', log: START_LOG }));

      await push(
        room({
          status: 'lobby',
          hostId: 'p1',
          players: [player('p1', 'Ana')],
          log: [
            ...START_LOG,
            entry(3, 'leave', 'Bea salió de la sala', 'p2'),
            entry(4, 'host', 'Ahora Ana es el anfitrión', 'p1'),
            entry(5, 'cancel', 'Partida cancelada: no hay suficientes jugadores'),
          ],
        }),
      );

      expect(toasts()).toEqual([
        'Bea salió de la sala. Partida cancelada: no hay suficientes jugadores. Ahora eres el anfitrión.',
      ]);
    });

    it('la revancha (resultados → lobby) y un cancel ya visto no se anuncian', async () => {
      const oldCancel = entry(3, 'cancel', 'Partida cancelada: no hay suficientes jugadores');
      await push(room({ status: 'playing', log: [...START_LOG, oldCancel] }));
      await push(room({ status: 'finished', log: [...START_LOG, oldCancel] }));
      await push(
        room({ status: 'lobby', log: [...START_LOG, oldCancel, entry(4, 'reset', 'Revancha')] }),
      );

      expect(toasts()).toEqual([]);
    });
  });
});
