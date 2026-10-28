import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import {
  DEFAULT_SETTINGS,
  formatRoomCode,
  SETTINGS_LIMITS,
  type PenaltyMode,
  type RoomSettings,
} from '../../../../shared/protocol';
import { GameStore } from '../../core/services/game.store';
import { ProfileService } from '../../core/services/profile.service';
import { SocketService } from '../../core/services/socket.service';
import { SoundService } from '../../core/services/sound.service';
import { ToastService } from '../../core/services/toast.service';
import { SettingsForm } from '../../shared/settings-form/settings-form';
import { TopBar } from '../../shared/top-bar/top-bar';
import { PlayerChip } from '../home/player-chip/player-chip';

const STORAGE_KEY = 'rr.lastSettings';
const MODES: readonly PenaltyMode[] = ['all', 'turn'];

/** Entero dentro de los límites (ajustado al paso); si no es un número usa el valor por defecto. */
function bounded(value: unknown, fallback: number, min: number, max: number, step = 1): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, Math.round(value / step) * step));
}

/** Últimas reglas usadas por este navegador, saneadas con los límites del protocolo. */
function loadSettings(): RoomSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<
      Record<keyof RoomSettings, unknown>
    > | null;
    if (!raw || typeof raw !== 'object') {
      return { ...DEFAULT_SETTINGS };
    }
    const { targetScore: T, penaltyNumber: P, maxPlayers: M } = SETTINGS_LIMITS;
    const d = DEFAULT_SETTINGS;
    return {
      targetScore: bounded(raw.targetScore, d.targetScore, T.min, T.max, T.step),
      penaltyNumber: bounded(raw.penaltyNumber, d.penaltyNumber, P.min, P.max),
      penaltyMode: MODES.find((m) => m === raw.penaltyMode) ?? d.penaltyMode,
      maxPlayers: bounded(raw.maxPlayers, d.maxPlayers, M.min, M.max),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Configuración de una sala nueva (el creador queda como anfitrión). */
@Component({
  selector: 'app-create-room',
  imports: [RouterLink, TopBar, SettingsForm, PlayerChip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './create-room.html',
  styleUrl: './create-room.scss',
})
export class CreateRoom {
  private readonly store = inject(GameStore);
  private readonly profile = inject(ProfileService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly sound = inject(SoundService);
  private readonly socket = inject(SocketService);

  protected readonly settings = signal<RoomSettings>(loadSettings());
  protected readonly creating = signal(false);
  protected readonly offline = computed(() => this.socket.status() === 'offline');
  /** Sin conexión la petición no saldría: el botón espera a que el socket esté en línea. */
  protected readonly online = computed(() => this.socket.status() === 'online');
  /** Sala en la que ya está el jugador (crear otra lo saca de ella). */
  protected readonly currentRoom = computed(() => this.store.session()?.code ?? null);
  protected readonly formatRoomCode = formatRoomCode;

  constructor() {
    effect(() => {
      const settings = this.settings();
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
      } catch {
        // Sin almacenamiento: no se recuerdan las reglas.
      }
    });
  }

  protected async create(): Promise<void> {
    if (this.creating()) {
      return;
    }
    if (!this.profile.hasValidName()) {
      this.toast.show('Primero escribe tu apodo de jugador.', 'warning');
      void this.router.navigateByUrl('/');
      return;
    }
    this.creating.set(true);
    this.sound.play('click');
    try {
      const code = await this.store.createRoom(this.settings());
      this.sound.play('join');
      await this.router.navigate(['/sala', code]);
    } catch (err) {
      this.toast.fromError(err);
    } finally {
      this.creating.set(false);
    }
  }
}
