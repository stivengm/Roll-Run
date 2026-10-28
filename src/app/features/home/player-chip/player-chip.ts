import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ProfileService } from '../../../core/services/profile.service';
import { Avatar } from '../../../shared/avatar/avatar';

/** Resumen "Jugarás como [avatar] Apodo". La acción (cambiar) se proyecta a la derecha. */
@Component({
  selector: 'app-player-chip',
  imports: [Avatar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './player-chip.html',
  styleUrl: './player-chip.scss',
})
export class PlayerChip {
  private readonly profileService = inject(ProfileService);

  protected readonly avatar = computed(() => this.profileService.profile().avatar);
  protected readonly name = computed(() => this.profileService.snapshot().name);
}
