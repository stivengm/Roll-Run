import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  DEFAULT_SETTINGS,
  formatRoomCode,
  type PlayerView,
  type RoomSettings,
} from '../../../../../shared/protocol';
import { GameStore } from '../../../core/services/game.store';
import { SoundService } from '../../../core/services/sound.service';
import { ToastService } from '../../../core/services/toast.service';
import { Avatar } from '../../../shared/avatar/avatar';
import { SettingsForm } from '../../../shared/settings-form/settings-form';
import { Sheet } from '../../../shared/sheet/sheet';

const MIN_TO_START = 2;

function sameSettings(a: RoomSettings, b: RoomSettings): boolean {
  return (
    a.targetScore === b.targetScore &&
    a.penaltyNumber === b.penaltyNumber &&
    a.penaltyMode === b.penaltyMode &&
    a.maxPlayers === b.maxPlayers
  );
}

/** Copia al portapapeles; en contextos no seguros (http en la LAN) usa execCommand. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const active = document.activeElement as HTMLElement | null;
    const area = document.createElement('textarea');
    try {
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
      document.body.append(area);
      area.select();
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      area.remove();
      active?.focus({ preventScroll: true });
    }
  }
}

/** Sala de espera: código, reglas, jugadores en orden de llegada y acciones del anfitrión. */
@Component({
  selector: 'app-lobby',
  imports: [Avatar, Sheet, SettingsForm],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './lobby.html',
  styleUrl: './lobby.scss',
})
export class Lobby {
  protected readonly store = inject(GameStore);
  private readonly toast = inject(ToastService);
  private readonly sound = inject(SoundService);

  protected readonly settings = computed(() => this.store.room()?.settings ?? DEFAULT_SETTINGS);
  protected readonly myId = computed(() => this.store.session()?.playerId ?? null);
  protected readonly codeParts = computed(() =>
    formatRoomCode(this.store.room()?.code ?? '').split(' · '),
  );
  protected readonly count = computed(() => this.store.players().length);
  protected readonly fillPct = computed(() =>
    Math.min(100, (this.count() / Math.max(1, this.settings().maxPlayers)) * 100),
  );
  protected readonly hasSlot = computed(() => this.count() < this.settings().maxPlayers);
  protected readonly ready = computed(() => this.store.connectedCount() >= MIN_TO_START);
  protected readonly hostName = computed(() => this.store.host()?.name ?? 'el anfitrión');
  /** Aviso al anfitrión: quien no vuelva a tiempo queda fuera o pierde sus turnos. */
  protected readonly offlineNote = computed(() => {
    const names = this.store
      .players()
      .filter((p) => !p.connected)
      .map((p) => p.name);
    if (names.length === 0) {
      return null;
    }
    const list =
      names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} y ${names.at(-1)}`;
    return names.length === 1
      ? `${list} está sin conexión. Si inicias ahora, puede quedar fuera de la partida o perder turnos hasta que vuelva.`
      : `${list} están sin conexión. Si inicias ahora, pueden quedar fuera de la partida o perder turnos hasta que vuelvan.`;
  });

  protected readonly copied = signal(false);
  protected readonly announcement = signal('');

  protected readonly editOpen = signal(false);
  protected readonly draft = signal<RoomSettings>(DEFAULT_SETTINGS);
  protected readonly formId = 'rr-lobby-settings';

  protected readonly kickOpen = signal(false);
  protected readonly kickTarget = signal<PlayerView | null>(null);

  /** id → nombre de los jugadores vistos en el último estado (null hasta el primero). */
  private known: Map<string, string> | null = null;
  private lastSettings: RoomSettings | null = null;
  private copiedTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    // Llegadas y salidas: sonido para quien entra y aviso para lectores de pantalla.
    effect(() => {
      const players = this.store.players();
      untracked(() => this.trackRoster(players));
    });

    // Los invitados se enteran cuando el anfitrión cambia las reglas.
    effect(() => {
      const settings = this.store.room()?.settings ?? null;
      untracked(() => {
        const prev = this.lastSettings;
        this.lastSettings = settings;
        if (prev && settings && !sameSettings(prev, settings) && !this.store.isHost()) {
          this.toast.show('El anfitrión actualizó las reglas.', 'info', 3200, 'tune');
        }
      });
    });

    // Cierra las hojas que ya no aplican (perdí el rol, o el jugador ya no está).
    effect(() => {
      if (this.editOpen() && !this.store.isHost()) {
        this.editOpen.set(false);
      }
      const target = this.kickTarget();
      if (this.kickOpen() && target && !this.store.players().some((p) => p.id === target.id)) {
        this.kickOpen.set(false);
      }
    });

    inject(DestroyRef).onDestroy(() => clearTimeout(this.copiedTimer));
  }

  // ------------------------------------------------------------------ Código y enlace

  protected async copyCode(): Promise<void> {
    const code = this.store.room()?.code;
    if (!code) {
      return;
    }
    if (await copyText(code)) {
      this.toast.show('Código copiado', 'success', 2200, 'content_copy');
      this.copied.set(true);
      clearTimeout(this.copiedTimer);
      this.copiedTimer = setTimeout(() => this.copied.set(false), 1800);
    } else {
      this.toast.error('No se pudo copiar el código.');
    }
  }

  protected async share(): Promise<void> {
    const code = this.store.room()?.code;
    if (!code) {
      return;
    }
    const url = new URL(`unirse/${code}`, document.baseURI).href;
    const data: ShareData = { title: 'Roll&Run', text: 'Únete a mi sala de Roll&Run', url };
    if (typeof navigator.share === 'function' && (navigator.canShare?.(data) ?? true)) {
      try {
        await navigator.share(data);
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
      }
    }
    if (await copyText(url)) {
      this.toast.show('Enlace copiado. ¡Pásalo a tus amigos!', 'success', 2800, 'link');
    } else {
      this.toast.error('No se pudo compartir el enlace.');
    }
  }

  // ------------------------------------------------------------------ Anfitrión

  protected start(): void {
    if (this.store.isHost() && this.ready() && !this.store.busy() && this.store.online()) {
      void this.store.start();
    }
  }

  protected openEdit(): void {
    const room = this.store.room();
    if (!room) {
      return;
    }
    const { settings } = room;
    this.draft.set({ ...settings, maxPlayers: Math.max(settings.maxPlayers, room.players.length) });
    this.editOpen.set(true);
  }

  protected async save(event?: Event): Promise<void> {
    event?.preventDefault();
    const before = this.store.room()?.settings;
    const next = this.draft();
    if (!before || this.store.busy() || !this.store.online()) {
      return;
    }
    if (sameSettings(before, next)) {
      this.editOpen.set(false);
      return;
    }
    await this.store.updateSettings(next);
    // El servidor emite el estado antes del ack: si cambió, se guardó (si no, ya hubo toast de error).
    const after = this.store.room()?.settings;
    if (after && !sameSettings(before, after)) {
      this.editOpen.set(false);
      this.toast.show('Reglas actualizadas', 'success', 2400, 'tune');
    }
  }

  protected askKick(player: PlayerView): void {
    this.kickTarget.set(player);
    this.kickOpen.set(true);
  }

  protected async confirmKick(): Promise<void> {
    const target = this.kickTarget();
    if (!target || this.store.busy() || !this.store.online()) {
      return;
    }
    await this.store.kick(target.id);
    this.kickOpen.set(false);
  }

  // ------------------------------------------------------------------ Internos

  private trackRoster(players: PlayerView[]): void {
    const prev = this.known;
    this.known = new Map(players.map((p) => [p.id, p.name]));
    if (!prev) {
      return;
    }
    const myId = this.myId();
    const joined = players.filter((p) => !prev.has(p.id) && p.id !== myId);
    const left = [...prev].filter(([id]) => !this.known?.has(id)).map(([, name]) => name);
    if (joined.length > 0) {
      this.sound.play('join');
    }
    const lines = [
      ...joined.map((p) => `${p.name} entró a la sala.`),
      ...left.map((name) => `${name} salió de la sala.`),
    ];
    if (lines.length > 0) {
      this.announcement.set(lines.join(' '));
    }
  }
}
