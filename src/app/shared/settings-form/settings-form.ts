import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  model,
} from '@angular/core';
import {
  PENALTY_MODE_LABELS,
  SETTINGS_LIMITS,
  type PenaltyMode,
  type RoomSettings,
} from '../../../../shared/protocol';

const { targetScore: TARGET, maxPlayers: PLAYERS } = SETTINGS_LIMITS;
const MODES: readonly PenaltyMode[] = ['all', 'turn'];

let nextId = 0;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Avance en un radiogroup según la tecla (flechas, Inicio, Fin); `null` si no aplica. */
function radioIndex(key: string, index: number, count: number): number | null {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (index + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/** Formulario de reglas de la sala (meta, penitencia, modo y cupo). Emite objetos nuevos. */
@Component({
  selector: 'app-settings-form',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './settings-form.html',
  styleUrl: './settings-form.scss',
})
export class SettingsForm {
  readonly settings = model.required<RoomSettings>();
  /** Cota inferior del cupo (p. ej. jugadores que ya están en la sala). */
  readonly minPlayers = input<number>(PLAYERS.min);
  readonly disabled = input(false);

  protected readonly limits = SETTINGS_LIMITS;
  protected readonly faces: readonly number[] = [1, 2, 3, 4, 5, 6];
  protected readonly shortcuts = [30, 50, 100] as const;
  protected readonly playerMarks = [2, 4, 6, 8] as const;
  protected readonly modes = MODES.map((id) => ({ id, ...PENALTY_MODE_LABELS[id] }));

  private readonly uid = ++nextId;
  protected readonly ids = {
    target: `rr-set-target-${this.uid}`,
    penalty: `rr-set-penalty-${this.uid}`,
    mode: `rr-set-mode-${this.uid}`,
    players: `rr-set-players-${this.uid}`,
  };

  protected readonly playersFloor = computed(() =>
    clamp(Math.round(this.minPlayers()), PLAYERS.min, PLAYERS.max),
  );
  protected readonly penaltyHint = computed(() =>
    this.settings().penaltyMode === 'turn'
      ? 'Si sale este número, el jugador pierde lo sumado en el turno y pasa el turno.'
      : 'Si sale este número, el jugador queda en 0 puntos y pasa el turno.',
  );

  private repeatTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stopRepeat());
  }

  /** Posición (0..1) de un número de jugadores sobre el slider. */
  protected playersFrac(value: number): number {
    return (value - PLAYERS.min) / (PLAYERS.max - PLAYERS.min);
  }

  protected patch(patch: Partial<RoomSettings>): void {
    if (!this.disabled()) {
      this.settings.update((s) => ({ ...s, ...patch }));
    }
  }

  // ------------------------------------------------------------------ Meta de puntos

  /** Sube o baja un paso (ajustando a múltiplos del paso). Devuelve si hubo cambio. */
  protected stepTarget(dir: 1 | -1): boolean {
    if (this.disabled()) {
      return false;
    }
    const current = this.settings().targetScore;
    const base =
      dir > 0
        ? Math.floor(current / TARGET.step) * TARGET.step
        : Math.ceil(current / TARGET.step) * TARGET.step;
    const next = clamp(base + dir * TARGET.step, TARGET.min, TARGET.max);
    if (next === current) {
      return false;
    }
    this.patch({ targetScore: next });
    return true;
  }

  /** Mantener pulsado repite el paso cada vez más rápido. */
  protected startRepeat(dir: 1 | -1, event: PointerEvent): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    this.stopRepeat();
    if (!this.stepTarget(dir)) {
      return;
    }
    let delay = 380;
    const tick = () => {
      if (!this.stepTarget(dir)) {
        this.stopRepeat();
        return;
      }
      delay = Math.max(45, delay * 0.78);
      this.repeatTimer = setTimeout(tick, delay);
    };
    this.repeatTimer = setTimeout(tick, delay);
  }

  protected stopRepeat(): void {
    if (this.repeatTimer !== null) {
      clearTimeout(this.repeatTimer);
      this.repeatTimer = null;
    }
  }

  /** Solo para activación por teclado (detail 0): el puntero ya lo gestiona startRepeat. */
  protected onStepClick(dir: 1 | -1, event: MouseEvent): void {
    if (event.detail === 0) {
      this.stepTarget(dir);
    }
  }

  /** Enter confirma el número; sin `preventDefault` enviaría el formulario (crear / guardar). */
  protected onTargetEnter(event: Event): void {
    event.preventDefault();
    this.commitTarget(event);
  }

  protected commitTarget(event: Event): void {
    const field = event.target as HTMLInputElement;
    const raw = Number(field.value);
    const current = this.settings().targetScore;
    const next =
      Number.isFinite(raw) && field.value.trim() !== ''
        ? clamp(Math.round(raw / TARGET.step) * TARGET.step, TARGET.min, TARGET.max)
        : current;
    field.value = String(next);
    if (next !== current) {
      this.patch({ targetScore: next });
    }
  }

  // ------------------------------------------------------------------ Penitencia

  protected onFaceKey(event: KeyboardEvent): void {
    const index = this.faces.indexOf(this.settings().penaltyNumber);
    const next = radioIndex(event.key, Math.max(0, index), this.faces.length);
    if (next === null) {
      return;
    }
    event.preventDefault();
    this.patch({ penaltyNumber: this.faces[next] });
    this.focusRadio(event, next);
  }

  protected onModeKey(event: KeyboardEvent): void {
    const index = MODES.indexOf(this.settings().penaltyMode);
    const next = radioIndex(event.key, Math.max(0, index), MODES.length);
    if (next === null) {
      return;
    }
    event.preventDefault();
    this.patch({ penaltyMode: MODES[next] });
    this.focusRadio(event, next);
  }

  // ------------------------------------------------------------------ Jugadores

  protected onPlayers(event: Event): void {
    const field = event.target as HTMLInputElement;
    const next = clamp(Math.round(Number(field.value)), this.playersFloor(), PLAYERS.max);
    if (String(next) !== field.value) {
      field.value = String(next);
    }
    if (next !== this.settings().maxPlayers) {
      this.patch({ maxPlayers: next });
    }
  }

  private focusRadio(event: KeyboardEvent, index: number): void {
    const group = event.currentTarget as HTMLElement;
    (group.children.item(index) as HTMLElement | null)?.focus();
  }
}
