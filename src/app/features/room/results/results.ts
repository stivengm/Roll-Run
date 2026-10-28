import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { DEFAULT_SETTINGS, TIMINGS } from '../../../../../shared/protocol';
import { GameStore } from '../../../core/services/game.store';
import { SoundService } from '../../../core/services/sound.service';
import { Avatar } from '../../../shared/avatar/avatar';
import { Confetti } from '../../../shared/confetti/confetti';

/** Margen para no repetir la fanfarria que Game toca justo antes (TIMINGS.winMs). */
const WIN_SOUND_GAP_MS = TIMINGS.winMs + 2000;

/** Pantalla de victoria: ganador, clasificación final y revancha. */
@Component({
  selector: 'app-results',
  imports: [Avatar, Confetti],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './results.html',
  styleUrl: './results.scss',
})
export class Results {
  protected readonly store = inject(GameStore);
  private readonly sound = inject(SoundService);
  private readonly router = inject(Router);

  protected readonly room = this.store.room;
  protected readonly settings = computed(() => this.room()?.settings ?? DEFAULT_SETTINGS);
  /** Instantánea del ganador: existe aunque ya haya salido de la sala. */
  protected readonly winner = computed(() => this.room()?.winner ?? null);
  protected readonly myId = computed(() => this.store.session()?.playerId ?? null);
  protected readonly iWon = computed(() => !!this.winner() && this.winner()?.id === this.myId());
  /** Estadísticas del ganador, solo si sigue en la sala. */
  protected readonly winnerStats = computed(
    () => this.store.playerById(this.winner()?.id)?.stats ?? null,
  );

  /** Resto de jugadores por score; empates comparten puesto (el ganador es el 1°). */
  protected readonly others = computed(() => {
    const winnerId = this.winner()?.id;
    const rows = this.store.leaderboard().filter((row) => row.player.id !== winnerId);
    return rows.map((row) => ({
      player: row.player,
      place: rows.findIndex((r) => r.player.score === row.player.score) + 2,
    }));
  });

  protected readonly myPlace = computed(
    () => this.others().find((row) => row.player.id === this.myId())?.place ?? null,
  );

  protected readonly leaving = signal(false);

  constructor() {
    afterNextRender(() => {
      // Venimos de la pantalla de juego, posiblemente con scroll: empezamos arriba.
      window.scrollTo({ top: 0 });
      // Si la partida acaba de terminar, Game ya tocó la fanfarria al aterrizar el dado.
      this.sound.play('win', WIN_SOUND_GAP_MS);
    });
  }

  protected restart(): void {
    if (!this.store.busy() && this.store.online()) {
      void this.store.restart();
    }
  }

  protected async exit(): Promise<void> {
    if (this.leaving()) {
      return;
    }
    this.leaving.set(true);
    await this.store.leave();
    await this.router.navigateByUrl('/', { replaceUrl: true });
  }
}
