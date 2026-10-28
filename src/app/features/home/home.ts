import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { Router } from '@angular/router';
import { DEFAULT_SETTINGS, formatRoomCode } from '../../../../shared/protocol';
import { GameStore } from '../../core/services/game.store';
import { ProfileService } from '../../core/services/profile.service';
import { SocketService } from '../../core/services/socket.service';
import { SoundService } from '../../core/services/sound.service';
import { ToastService } from '../../core/services/toast.service';
import { environment } from '../../../environments/environment';
import { RulesSheet } from '../../shared/rules-sheet/rules-sheet';
import { ProfileCard } from './profile-card/profile-card';

const STATUS_LABELS = {
  online: 'Servidor online',
  connecting: 'Conectando…',
  offline: 'Sin conexión',
} as const;

/** Pantalla de bienvenida: perfil del jugador y acceso a crear o unirse a una sala. */
@Component({
  selector: 'app-home',
  imports: [ProfileCard, RulesSheet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './home.html',
  styleUrl: './home.scss',
})
export class Home {
  private readonly router = inject(Router);
  private readonly profile = inject(ProfileService);
  private readonly toast = inject(ToastService);
  private readonly store = inject(GameStore);
  protected readonly sound = inject(SoundService);

  private readonly profileCard = viewChild.required(ProfileCard);

  protected readonly version = environment.version;
  protected readonly defaultSettings = DEFAULT_SETTINGS;
  protected readonly status = inject(SocketService).status;
  protected readonly statusLabel = computed(() => STATUS_LABELS[this.status()]);
  protected readonly sessionCode = computed(() => this.store.session()?.code ?? null);
  /** La partida me espera: es mi turno aunque esté fuera de la sala. */
  protected readonly myTurn = this.store.isMyTurn;
  protected readonly rulesOpen = signal(false);
  protected readonly formatRoomCode = formatRoomCode;

  protected go(path: '/crear' | '/unirse'): void {
    if (!this.profile.hasValidName()) {
      this.toast.show(this.profile.nameProblem() ?? 'Escribe tu apodo para jugar.', 'warning');
      this.profileCard().nudge();
      return;
    }
    this.sound.play('click');
    void this.router.navigateByUrl(path);
  }

  protected resume(code: string): void {
    this.sound.play('click');
    void this.router.navigate(['/sala', code]);
  }
}
