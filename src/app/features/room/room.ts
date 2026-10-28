import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { Title } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { formatRoomCode } from '../../../../shared/protocol';
import type { LogEntry, RoomStatus } from '../../../../shared/protocol';
import type { ConfirmLeave } from '../../core/guards/leave.guard';
import { GameStore } from '../../core/services/game.store';
import { ToastService } from '../../core/services/toast.service';
import { Dice } from '../../shared/dice/dice';
import { RulesSheet } from '../../shared/rules-sheet/rules-sheet';
import { Sheet } from '../../shared/sheet/sheet';
import { TopBar } from '../../shared/top-bar/top-bar';
import { Game } from './game/game';
import { Lobby } from './lobby/lobby';
import { Results } from './results/results';

/** Contenedor de la sala (`/sala/:code`): conecta con la sala y muestra lobby, partida o resultados. */
@Component({
  selector: 'app-room',
  imports: [TopBar, Dice, Sheet, RulesSheet, Lobby, Game, Results],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './room.html',
  styleUrl: './room.scss',
})
export class Room implements ConfirmLeave {
  readonly code = input.required<string>();

  private readonly store = inject(GameStore);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly title = inject(Title);

  /** La sala del store, solo si es la de esta ruta. */
  protected readonly room = computed(() => {
    const room = this.store.room();
    return room?.code === this.code() ? room : null;
  });
  protected readonly offline = computed(() => this.store.connection() !== 'online');

  protected readonly rulesOpen = signal(false);
  protected readonly leaveOpen = signal(false);
  protected readonly leaving = signal(false);

  protected readonly leaveLines = computed(() => {
    const room = this.room();
    const myId = this.store.session()?.playerId;
    if (!room) {
      return [];
    }
    const lines: string[] = [];
    if (room.status === 'playing') {
      lines.push('Perderás tu lugar en la partida.');
      if (room.players.length <= 2) {
        lines.push('La partida se cancelará por falta de jugadores.');
      }
    }
    if (room.hostId === myId) {
      // Mismo criterio que el servidor: el primer conectado en orden de llegada.
      const others = room.players.filter((p) => p.id !== myId);
      const heir = others.find((p) => p.connected) ?? others[0];
      if (heir) {
        lines.push(`El rol de anfitrión pasará a ${heir.name}.`);
      }
    }
    if (lines.length === 0) {
      lines.push('Podrás volver a entrar con el código mientras la sala siga abierta.');
    }
    return lines;
  });

  private loadSeq = 0;
  private hadRoom = false;
  private lastStatus: RoomStatus | null = null;
  /** Último evento del registro ya visto (para no anunciar dos veces lo mismo). */
  private lastLogId = 0;

  constructor() {
    effect(() => {
      const code = this.code();
      this.title.setTitle(`Sala ${formatRoomCode(code)} · Roll&Run`);
      untracked(() => void this.load(code));
    });

    // Si la sala desaparece del store (expulsión, sala cerrada…) volvemos al inicio.
    effect(() => {
      const present = this.store.room() !== null;
      untracked(() => {
        if (present) {
          this.hadRoom = true;
        } else if (this.hadRoom && !this.leaving()) {
          this.hadRoom = false;
          this.goHome();
        }
      });
    });

    // Lobby → partida → resultados no cambian de ruta: cada pantalla nueva empieza arriba.
    effect(() => {
      const room = this.room();
      const status = room?.status ?? null;
      untracked(() => {
        if (status && this.lastStatus && status !== this.lastStatus) {
          window.scrollTo({ top: 0 });
          // Partida → lobby solo ocurre si se cancela por falta de jugadores.
          if (room && this.lastStatus === 'playing' && status === 'lobby' && !this.leaving()) {
            this.notifyCancelled(room.log);
          }
        }
        this.lastStatus = status;
        this.lastLogId = room?.log.at(-1)?.id ?? this.lastLogId;
      });
    });

    inject(DestroyRef).onDestroy(() => this.loadSeq++);
  }

  /** Atrás del navegador o gesto atrás: misma confirmación que la flecha de la barra. */
  canLeave(): boolean {
    if (this.leaving() || !this.room() || this.store.session()?.code !== this.code()) {
      return true;
    }
    if (this.leaveOpen() || this.rulesOpen()) {
      // Con una hoja abierta, "atrás" solo la cierra, como un diálogo nativo.
      this.leaveOpen.set(false);
      this.rulesOpen.set(false);
    } else {
      this.leaveOpen.set(true);
    }
    return false;
  }

  protected askLeave(): void {
    if (this.room()) {
      this.leaveOpen.set(true);
    } else {
      this.goHome();
    }
  }

  protected async leave(): Promise<void> {
    if (this.leaving()) {
      return;
    }
    this.leaving.set(true);
    await this.store.leave();
    this.leaveOpen.set(false);
    // Reemplaza la entrada: "atrás" desde el inicio no debe volver a una sala que ya dejamos.
    await this.router.navigateByUrl('/', { replaceUrl: true });
  }

  private async load(code: string): Promise<void> {
    const seq = ++this.loadSeq;
    const result = await this.store.ensureRoom(code);
    if (seq !== this.loadSeq) {
      return;
    }
    if (result === 'no-session') {
      void this.router.navigate(['/unirse', code], { replaceUrl: true });
    } else if (result === 'failed' && !this.router.currentNavigation()) {
      // Si el store ya nos está sacando (reconexión fallida) evitamos un segundo aviso.
      this.toast.show(this.store.rejectionMessage, 'warning', 4200);
      this.goHome();
    }
  }

  /** Aviso para quien se queda cuando la partida se cancela porque otro salió. */
  private notifyCancelled(log: LogEntry[]): void {
    let at = log.length - 1;
    while (at >= 0 && log[at].kind !== 'cancel') {
      at--;
    }
    const cancel = log[at];
    if (!cancel || cancel.id <= this.lastLogId) {
      return;
    }
    const myId = this.store.session()?.playerId;
    let cause: LogEntry | undefined;
    let nowHost = false;
    for (let i = at - 1; i >= 0 && log[i].id > this.lastLogId; i--) {
      const entry = log[i];
      if (entry.kind === 'host' && entry.playerId === myId) {
        nowHost = true;
      } else if (!cause && (entry.kind === 'leave' || entry.kind === 'kick')) {
        cause = entry;
      }
    }
    const kickedByMe = cause?.kind === 'kick' && this.room()?.hostId === myId && !nowHost;
    const parts = [cause && !kickedByMe ? cause.text : null, cancel.text]
      .filter((text): text is string => !!text)
      .map((text) => text.replace(/\.$/, '') + '.');
    if (nowHost) {
      parts.push('Ahora eres el anfitrión.');
    }
    this.toast.show(parts.join(' '), 'warning', 5000, 'block');
  }

  private goHome(): void {
    if (!this.router.currentNavigation()) {
      void this.router.navigateByUrl('/', { replaceUrl: true });
    }
  }
}
