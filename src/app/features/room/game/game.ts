import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { DEFAULT_SETTINGS, TIMINGS } from '../../../../../shared/protocol';
import type { LogKind, PlayerView, RollView, RoomView } from '../../../../../shared/protocol';
import { GameStore } from '../../../core/services/game.store';
import { SoundService } from '../../../core/services/sound.service';
import { ToastService } from '../../../core/services/toast.service';
import { Avatar } from '../../../shared/avatar/avatar';
import { Dice, type DiceMood } from '../../../shared/dice/dice';

type StageState = 'ready' | 'rolling' | 'gain' | 'penalty' | 'won';
type Tone = 'yellow' | 'cyan' | 'orange-light' | 'red' | 'green';

interface PenaltyFx {
  id: number;
  name: string;
  mine: boolean;
  value: number;
  lost: number;
}

/** Momento (ms tras revelar) en que el dado toca el suelo: lo marca la animación de app-dice. */
const LAND_MS = 360;
const RESULT_SOUND_DELAY_MS = 110;
/** El aviso de penitencia se retira justo cuando el servidor pasa el turno. */
const PENALTY_FX_MS = TIMINGS.penaltyMs - LAND_MS;
const LOG_SIZE = 8;

/** Arista del dado: más pequeño en pantallas bajas para que las acciones se vean sin scroll. */
const DICE_SIZE = 148;
const SHORT_SCREENS = [
  { query: '(max-height: 600px)', size: 96 },
  { query: '(max-height: 760px)', size: 112 },
] as const;

const LOG_META: Record<LogKind, { icon: string; tone: Tone }> = {
  join: { icon: 'login', tone: 'green' },
  leave: { icon: 'logout', tone: 'orange-light' },
  kick: { icon: 'person_remove', tone: 'red' },
  host: { icon: 'star', tone: 'yellow' },
  settings: { icon: 'tune', tone: 'cyan' },
  start: { icon: 'flag', tone: 'cyan' },
  roll: { icon: 'casino', tone: 'yellow' },
  penalty: { icon: 'skull', tone: 'red' },
  pass: { icon: 'front_hand', tone: 'cyan' },
  skip: { icon: 'skip_next', tone: 'orange-light' },
  win: { icon: 'emoji_events', tone: 'yellow' },
  reset: { icon: 'restart_alt', tone: 'cyan' },
  cancel: { icon: 'block', tone: 'red' },
};

/** Pantalla de partida: turno actual, dado, acciones del jugador del turno, orden y clasificación. */
@Component({
  selector: 'app-game',
  imports: [Avatar, Dice],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './game.html',
  styleUrls: ['./game.scss', './game-fx.scss'],
  host: {
    '(document:keydown)': 'onKeydown($event)',
  },
})
export class Game {
  protected readonly store = inject(GameStore);
  protected readonly sound = inject(SoundService);
  private readonly toast = inject(ToastService);
  private readonly strip = viewChild<ElementRef<HTMLElement>>('strip');
  private readonly banner = viewChild<ElementRef<HTMLElement>>('banner');

  protected readonly room = this.store.room;
  protected readonly settings = computed(() => this.room()?.settings ?? DEFAULT_SETTINGS);
  protected readonly turn = computed(() => this.room()?.turn ?? null);
  protected readonly phase = computed(() => this.room()?.phase ?? 'idle');
  protected readonly current = this.store.currentPlayer;
  protected readonly isMyTurn = this.store.isMyTurn;
  protected readonly rolling = computed(() => this.phase() === 'rolling');

  /** Quien juega después del turno actual (orden de ingreso, circular). */
  protected readonly next = computed<PlayerView | null>(() => {
    const players = this.store.players();
    const current = this.current();
    if (!current || players.length < 2) {
      return null;
    }
    const index = players.findIndex((p) => p.id === current.id);
    return players[(index + 1) % players.length];
  });

  /** Último lanzamiento, solo si pertenece al turno en curso. */
  private readonly turnRoll = computed<RollView | null>(() => {
    const room = this.room();
    const roll = room?.lastRoll;
    const turn = room?.turn;
    if (!room || !roll || !turn || roll.playerId !== turn.playerId) {
      return null;
    }
    return room.phase === 'rolling' || turn.rolls.length > 0 ? roll : null;
  });

  /** Id del lanzamiento cuyo dado ya aterrizó (su resultado ya se puede mostrar). */
  private readonly landedId = signal<number | null>(null);
  /** Id del último log visible antes del lanzamiento en curso (para no adelantar el resultado). */
  private readonly logCutoff = signal(0);

  /** Valor ya revelado por el servidor cuyo dado aún está girando hacia su cara. */
  private readonly pending = computed(() => {
    const roll = this.turnRoll();
    return roll && roll.value !== null && roll.id !== this.landedId() ? roll : null;
  });

  /** Resultado visible del turno (tras aterrizar el dado). */
  protected readonly result = computed(() => {
    const roll = this.turnRoll();
    return roll && roll.value !== null && !this.pending() ? roll : null;
  });

  /**
   * Cara visible: la del turno o, al empezar uno nuevo, el último resultado real (el dado no
   * se recoloca en una cara que nadie sacó).
   */
  protected readonly diceValue = computed(
    () => (this.turnRoll() ?? this.room()?.lastRoll)?.value ?? null,
  );
  /** El dado muestra el resultado de un turno anterior: se atenúa. */
  protected readonly diceStale = computed(
    () => !this.turnRoll() && !!this.room()?.lastRoll && !this.rolling(),
  );
  protected readonly diceSize = signal(DICE_SIZE);

  protected readonly diceMood = computed<DiceMood>(() => {
    const phase = this.phase();
    return phase === 'penalty' ? 'penalty' : phase === 'won' ? 'win' : 'idle';
  });

  protected readonly stageState = computed<StageState>(() => {
    if (this.rolling() || this.pending()) {
      return 'rolling';
    }
    const result = this.result();
    if (!result) {
      return 'ready';
    }
    if (this.phase() === 'won') {
      return 'won';
    }
    return result.isPenalty ? 'penalty' : 'gain';
  });

  /** Clave que cambia con cada resultado: re-crea el texto del escenario para reanimarlo. */
  protected readonly captionKey = computed(
    () => `${this.stageState()}:${this.result()?.id ?? this.turn()?.number ?? 0}`,
  );

  /** "+N" flotante sobre el dado tras sumar. */
  protected readonly gainFx = computed(() => {
    const result = this.result();
    return result && !result.isPenalty ? [result] : [];
  });

  protected readonly turnRolls = computed(() => {
    const rolls = this.turn()?.rolls ?? [];
    return this.pending() ? rolls.slice(0, -1) : rolls;
  });

  protected readonly turnPoints = computed(() => {
    const points = this.turn()?.points ?? 0;
    const pending = this.pending();
    return pending && !pending.isPenalty ? points - (pending.value ?? 0) : points;
  });

  /** Clasificación con los scores que se están mostrando (sin adelantar el resultado). */
  protected readonly board = computed(() =>
    this.store
      .leaderboard()
      .map(({ player, order }) => ({ player, order, score: this.scoreOf(player) }))
      .sort((a, b) => b.score - a.score || a.order - b.order),
  );

  protected readonly recentLog = computed(() => {
    const log = this.room()?.log ?? [];
    const cutoff = this.pending() ? this.logCutoff() : Infinity;
    return log
      .filter((entry) => entry.id <= cutoff)
      .slice(-LOG_SIZE)
      .reverse();
  });

  protected readonly penaltyFx = signal<PenaltyFx | null>(null);
  protected readonly winFx = signal(false);

  private rollingId: number | null = null;
  private revealedId: number | null = null;
  private turnNumber: number | null = null;
  private synced = false;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor() {
    effect(() => {
      const room = this.room();
      if (room?.status === 'playing') {
        untracked(() => this.sync(room));
      }
    });
    const destroyRef = inject(DestroyRef);
    destroyRef.onDestroy(() => {
      this.timers.forEach(clearTimeout);
      this.timers.clear();
    });
    this.trackScreenHeight(destroyRef);
  }

  // ------------------------------------------------------------------ Acciones

  protected roll(): void {
    if (this.store.canRoll() && !this.store.busy()) {
      void this.store.roll();
    }
  }

  protected pass(): void {
    if (this.store.canPass() && !this.store.busy()) {
      this.sound.play('click');
      void this.store.pass();
    }
  }

  protected skip(): void {
    if (!this.store.busy() && this.store.online()) {
      void this.store.skip();
    }
  }

  protected dismissPenalty(): void {
    this.penaltyFx.set(null);
  }

  /** Atajos del jugador del turno: Espacio/Enter lanzan, P se planta. */
  protected onKeydown(event: KeyboardEvent): void {
    if (
      !this.isMyTurn() ||
      event.defaultPrevented ||
      event.repeat ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    ) {
      return;
    }
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (
      target?.isContentEditable ||
      target?.closest('input, textarea, select, [role="dialog"], dialog')
    ) {
      return;
    }
    if (event.key === ' ' || event.key === 'Enter') {
      // Sobre un botón o enlace, la tecla ya activa ese control.
      if (target?.closest('button, a[href], summary, [role="button"]')) {
        return;
      }
      event.preventDefault();
      this.roll();
    } else if (event.key === 'p' || event.key === 'P') {
      event.preventDefault();
      this.pass();
    }
  }

  // ------------------------------------------------------------------ Vista

  protected scoreOf(player: PlayerView | null): number {
    if (!player) {
      return 0;
    }
    const pending = this.pending();
    if (!pending || pending.playerId !== player.id) {
      return player.score;
    }
    return pending.isPenalty
      ? player.score + pending.lostPoints
      : player.score - (pending.value ?? 0);
  }

  protected percent(score: number): number {
    return Math.max(0, Math.min(100, (score / this.settings().targetScore) * 100));
  }

  protected logIcon(kind: LogKind): string {
    return LOG_META[kind]?.icon ?? 'info';
  }

  /** Color del ícono del evento (variable CSS del tema). */
  protected logTone(kind: LogKind): string {
    return `var(--rr-${LOG_META[kind]?.tone ?? 'cyan'})`;
  }

  // ------------------------------------------------------------------ Sincronización

  /** Reacciona a cada estado del servidor comparando ids previos (sonido, avisos, efectos). */
  private sync(room: RoomView): void {
    const first = !this.synced;
    this.synced = true;
    const roll = room.lastRoll;

    if (room.phase === 'rolling' && roll && roll.id !== this.rollingId) {
      this.rollingId = roll.id;
      this.logCutoff.set(room.log.at(-1)?.id ?? 0);
      this.sound.play('roll');
    }

    if (roll && roll.value !== null && roll.id !== this.revealedId) {
      this.revealedId = roll.id;
      if (!first && this.rollingId === roll.id) {
        const won = room.phase === 'won';
        this.later(LAND_MS, () => this.land(roll, won));
      } else {
        // Llegamos con el resultado ya revelado (recarga / reconexión): sin efectos.
        this.landedId.set(roll.id);
      }
    }

    const turn = room.turn;
    if (turn && turn.number !== this.turnNumber) {
      this.turnNumber = turn.number;
      const mine = turn.playerId === this.store.session()?.playerId;
      if (mine && room.phase === 'idle' && turn.rolls.length === 0) {
        this.sound.play('turn');
        this.vibrate(80);
        // Tras pintar: el aviso depende de si el banner del turno está a la vista.
        const number = turn.number;
        this.later(0, () => this.announceTurn(number));
      }
      this.later(first ? 0 : 60, () => this.centerStrip());
    }
  }

  private land(roll: RollView, won: boolean): void {
    this.landedId.set(roll.id);
    this.sound.play('land');
    this.later(RESULT_SOUND_DELAY_MS, () =>
      this.sound.play(won ? 'win' : roll.isPenalty ? 'penalty' : 'gain'),
    );
    if (won) {
      this.winFx.set(true);
    }
    if (roll.isPenalty) {
      const mine = roll.playerId === this.store.session()?.playerId;
      this.penaltyFx.set({
        id: roll.id,
        name: this.store.playerById(roll.playerId)?.name ?? 'El jugador',
        mine,
        value: roll.value ?? this.settings().penaltyNumber,
        lost: roll.lostPoints,
      });
      if (mine) {
        this.vibrate([90, 50, 160]);
      }
      this.later(PENALTY_FX_MS, () => {
        if (this.penaltyFx()?.id === roll.id) {
          this.penaltyFx.set(null);
        }
      });
    }
  }

  /** El banner ya dice "¡Es tu turno!": el aviso flotante solo hace falta si no se ve. */
  private announceTurn(number: number): void {
    if (
      !this.isMyTurn() ||
      this.turn()?.number !== number ||
      this.phase() !== 'idle' ||
      this.bannerVisible()
    ) {
      return;
    }
    this.toast.show('¡Es tu turno!', 'info', 2400, 'casino');
  }

  /** Al menos media altura del banner visible bajo la barra superior (sticky). */
  private bannerVisible(): boolean {
    const banner = this.banner()?.nativeElement;
    if (!banner) {
      return false;
    }
    const rect = banner.getBoundingClientRect();
    const barBottom = document.querySelector('app-top-bar')?.getBoundingClientRect().bottom ?? 0;
    const shown = Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, barBottom);
    return shown >= rect.height / 2;
  }

  private trackScreenHeight(destroyRef: DestroyRef): void {
    if (typeof matchMedia !== 'function') {
      return;
    }
    const queries = SHORT_SCREENS.map(({ query, size }) => ({ list: matchMedia(query), size }));
    const update = () =>
      this.diceSize.set(queries.find(({ list }) => list.matches)?.size ?? DICE_SIZE);
    update();
    queries.forEach(({ list }) => list.addEventListener('change', update));
    destroyRef.onDestroy(() =>
      queries.forEach(({ list }) => list.removeEventListener('change', update)),
    );
  }

  /** Centra el jugador del turno en la tira de orden (sin mover el scroll vertical). */
  private centerStrip(): void {
    const strip = this.strip()?.nativeElement;
    const item = strip?.querySelector<HTMLElement>('.is-current');
    if (!strip || !item || strip.scrollWidth <= strip.clientWidth) {
      return;
    }
    const left = item.offsetLeft - (strip.clientWidth - item.offsetWidth) / 2;
    strip.scrollTo({ left, behavior: 'smooth' });
  }

  private later(ms: number, fn: () => void): void {
    const id = setTimeout(() => {
      this.timers.delete(id);
      fn();
    }, ms);
    this.timers.add(id);
  }

  private vibrate(pattern: number | number[]): void {
    try {
      // Sin un gesto previo del usuario el navegador lo bloquea (y lo reporta en consola).
      if (navigator.userActivation?.hasBeenActive) {
        navigator.vibrate?.(pattern);
      }
    } catch {
      // Sin soporte de vibración.
    }
  }
}
