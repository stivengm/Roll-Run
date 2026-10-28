import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import {
  DEFAULT_SETTINGS,
  type PlayerView,
  type RollView,
  type RoomView,
  type SessionInfo,
} from '../../../../../shared/protocol';
import { GameStore } from '../../../core/services/game.store';
import { ProfileService } from '../../../core/services/profile.service';
import { SocketService, type ConnectionStatus } from '../../../core/services/socket.service';
import { SoundService } from '../../../core/services/sound.service';
import { ToastService } from '../../../core/services/toast.service';
import { Game } from './game';

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

function player(id: string): PlayerView {
  return {
    id,
    name: id.toUpperCase(),
    avatar: 'bolt',
    score: 0,
    connected: true,
    joinedAt: 0,
    stats: { rolls: 0, penalties: 0, bestTurn: 0 },
  };
}

function roll(patch: Partial<RollView> = {}): RollView {
  return {
    id: 1,
    playerId: 'p1',
    value: 3,
    isPenalty: false,
    lostPoints: 0,
    scoreAfter: 3,
    ...patch,
  };
}

function playing(
  turn: { playerId: string; number: number; rolls: number[] },
  lastRoll: RollView | null,
  phase: RoomView['phase'] = 'idle',
): RoomView {
  return {
    code: SESSION.code,
    hostId: 'p1',
    status: 'playing',
    phase,
    settings: DEFAULT_SETTINGS,
    players: [player('p1'), player('p2')],
    turn: { ...turn, points: 0, startedAt: 0 },
    lastRoll,
    winner: null,
    round: 1,
    log: [],
    serverTime: 0,
  };
}

function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
    toJSON: () => ({}),
  };
}

describe('Game', () => {
  let socket: FakeSocket;
  let fixture: ComponentFixture<Game>;

  /** Solo el aviso de la pantalla de juego (el store avisa aparte si estás fuera de la sala). */
  const turnToasts = () =>
    TestBed.inject(ToastService)
      .toasts()
      .map((t) => t.text)
      .filter((text) => text === '¡Es tu turno!');

  async function push(state: RoomView): Promise<void> {
    socket.emit('room:state', state);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  beforeEach(async () => {
    sessionStorage.clear();
    localStorage.clear();
    socket = new FakeSocket();
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: SocketService, useValue: socket }],
    });
    // Sin la plantilla real: basta el banner para medir su visibilidad.
    TestBed.overrideComponent(Game, {
      set: { template: '<section #banner class="banner"></section>', imports: [] },
    });
    TestBed.inject(ProfileService).setName('P1');
    vi.spyOn(TestBed.inject(SoundService), 'play').mockImplementation(() => undefined);
    const store = TestBed.inject(GameStore);
    socket.request.mockResolvedValue({
      session: SESSION,
      room: playing({ playerId: 'p2', number: 1, rolls: [] }, null),
    });
    await store.joinRoom(SESSION.code);
  });

  afterEach(() => vi.restoreAllMocks());

  function mount(): Game {
    fixture = TestBed.createComponent(Game);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  describe('dado al cambiar de turno', () => {
    it('mantiene el último resultado real (atenuado) en vez de una cara de reposo', async () => {
      const game = mount();
      await push(playing({ playerId: 'p1', number: 1, rolls: [3] }, roll({ value: 3 })));
      expect([game['diceValue'](), game['diceStale']()]).toEqual([3, false]);

      // Se planta: empieza el turno de p2 sin tiradas; lastRoll sigue siendo el 3 de p1.
      await push(playing({ playerId: 'p2', number: 2, rolls: [] }, roll({ value: 3 })));
      expect([game['diceValue'](), game['diceStale']()]).toEqual([3, true]);

      // p2 lanza: mientras gira no se adelanta ningún valor.
      await push(
        playing(
          { playerId: 'p2', number: 2, rolls: [] },
          roll({ id: 2, playerId: 'p2', value: null }),
          'rolling',
        ),
      );
      expect([game['diceValue'](), game['diceStale']()]).toEqual([null, false]);
    });

    it('sin lanzamientos en la partida no hay valor (cara de reposo inicial)', () => {
      const game = mount();
      expect(game['diceValue']()).toBeNull();
      expect(game['diceStale']()).toBe(false);
    });
  });

  describe('aviso "¡Es tu turno!"', () => {
    const myTurn = playing({ playerId: 'p1', number: 2, rolls: [] }, roll({ playerId: 'p2' }));

    it('no tapa el banner: si el banner está a la vista no hay toast', async () => {
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(rect(85, 74));
      mount();
      await push(myTurn);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(turnToasts()).toEqual([]);
    });

    it('si el banner quedó fuera de la vista (scroll) sí avisa', async () => {
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(rect(-300, 74));
      mount();
      await push(myTurn);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(turnToasts()).toEqual(['¡Es tu turno!']);
    });
  });
});
