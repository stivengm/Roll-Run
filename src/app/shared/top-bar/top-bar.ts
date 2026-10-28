import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { Router } from '@angular/router';
import { ProfileService } from '../../core/services/profile.service';
import { SocketService } from '../../core/services/socket.service';
import { Avatar } from '../avatar/avatar';

const STATUS_LABELS = {
  online: 'Conectado',
  connecting: 'Conectando…',
  offline: 'Sin conexión',
} as const;

/** Barra superior sticky: atrás, logo y avatar del jugador. Proyecta botones extra a la derecha. */
@Component({
  selector: 'app-top-bar',
  imports: [Avatar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './top-bar.html',
  styleUrl: './top-bar.scss',
})
export class TopBar {
  private readonly router = inject(Router);
  private readonly profile = inject(ProfileService);
  private readonly socket = inject(SocketService);

  readonly showBack = input(true);
  readonly backTo = input('/');
  /** Si es `true`, el botón atrás solo emite `back` (la página decide qué hacer). */
  readonly interceptBack = input(false);
  readonly showProfile = input(true);
  readonly back = output<void>();

  protected readonly avatar = computed(() => this.profile.profile().avatar);
  protected readonly online = computed(() => this.socket.status() === 'online');
  protected readonly statusLabel = computed(() => STATUS_LABELS[this.socket.status()]);
  protected readonly profileLabel = computed(() => {
    const name = this.profile.profile().name.trim();
    return name ? `Tu perfil: ${name}` : 'Tu perfil';
  });

  protected onBack(): void {
    if (this.interceptBack()) {
      this.back.emit();
      return;
    }
    void this.router.navigateByUrl(this.backTo());
  }
}
