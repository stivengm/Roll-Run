import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import {
  DEFAULT_SETTINGS,
  PENALTY_MODE_LABELS,
  TIMINGS,
  type RoomSettings,
} from '../../../../shared/protocol';
import { Sheet } from '../sheet/sheet';

/** "Cómo jugar": reglas explicadas según la configuración de la sala. */
@Component({
  selector: 'app-rules-sheet',
  imports: [Sheet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './rules-sheet.html',
  styleUrl: './rules-sheet.scss',
})
export class RulesSheet {
  readonly open = input(false);
  readonly settings = input<RoomSettings>(DEFAULT_SETTINGS);
  /** Fuera de una sala: `settings` son solo los valores por defecto, no las reglas fijas. */
  readonly defaults = input(false);
  readonly closed = output<void>();

  protected readonly faces = [1, 2, 3, 4, 5, 6] as const;
  protected readonly skipSeconds = Math.round(TIMINGS.disconnectedTurnSkipMs / 1000);
  protected readonly mode = computed(() => PENALTY_MODE_LABELS[this.settings().penaltyMode]);
  protected readonly penaltyText = computed(() => {
    const { penaltyNumber, penaltyMode } = this.settings();
    if (this.defaults()) {
      return `Si sale el número de penitencia (por defecto, el ${penaltyNumber}), pierdes TODO tu score y vuelves a 0, o solo lo que sumaste en el turno si la sala usa ese modo. El turno pasa solo al siguiente jugador.`;
    }
    return penaltyMode === 'turn'
      ? `Si sale el ${penaltyNumber}, pierdes los puntos que sumaste en ese turno y el turno pasa solo al siguiente jugador.`
      : `Si sale el ${penaltyNumber}, pierdes TODO tu score (vuelves a 0) y el turno pasa solo al siguiente jugador.`;
  });
}
