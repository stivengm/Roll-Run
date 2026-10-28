import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  inject,
  Injector,
  input,
  linkedSignal,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { formatRoomCode, ROOM_CODE_LENGTH } from '../../../../shared/protocol';
import { GameStore } from '../../core/services/game.store';
import { ProfileService } from '../../core/services/profile.service';
import { SocketService } from '../../core/services/socket.service';
import { SoundService } from '../../core/services/sound.service';
import { ToastService } from '../../core/services/toast.service';
import { TopBar } from '../../shared/top-bar/top-bar';
import { PlayerChip } from '../home/player-chip/player-chip';
import { ProfileCard, restartShake } from '../home/profile-card/profile-card';

const LEN = ROOM_CODE_LENGTH;

function onlyDigits(text: string): string {
  return text.replace(/\D/g, '');
}

/** Extrae el código de un texto pegado: "882109", "882 · 109" o un enlace de invitación. */
function extractCode(text: string): string {
  const runs = [...text.matchAll(/(?:^|\D)(\d{6})(?=\D|$)/g)];
  if (runs.length) {
    return runs[runs.length - 1][1];
  }
  const split = text.match(/(?:^|\D)(\d{3})\D{1,3}(\d{3})(?=\D|$)/);
  return split ? split[1] + split[2] : onlyDigits(text).slice(0, LEN);
}

function isEditable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.matches('input, textarea, select'))
  );
}

/** Unirse a una sala con el código de 6 dígitos (teclado en pantalla, teclado físico o pegar). */
@Component({
  selector: 'app-join-room',
  imports: [RouterLink, TopBar, ProfileCard, PlayerChip],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './join-room.html',
  styleUrl: './join-room.scss',
  host: {
    '(document:keydown)': 'onKeydown($event)',
    '(document:paste)': 'onPaste($event)',
  },
})
export class JoinRoom {
  private readonly store = inject(GameStore);
  private readonly profile = inject(ProfileService);
  private readonly router = inject(Router);
  private readonly toast = inject(ToastService);
  private readonly sound = inject(SoundService);
  private readonly injector = inject(Injector);
  private readonly socket = inject(SocketService);
  protected readonly online = computed(() => this.socket.status() === 'online');

  /** Parámetro de ruta `unirse/:code` (enlace de invitación). */
  readonly code = input<string | undefined>();

  private readonly boxes = viewChild.required<ElementRef<HTMLElement>>('boxes');
  private readonly profileCard = viewChild(ProfileCard);

  protected readonly slots = Array.from({ length: LEN }, (_, i) => i);
  protected readonly keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9'] as const;

  protected readonly digits = linkedSignal(() => onlyDigits(this.code() ?? '').slice(0, LEN));
  /** Marca las casillas en rojo tras un intento fallido, hasta que cambie el código. */
  protected readonly error = linkedSignal({ source: this.digits, computation: () => false });
  protected readonly joining = signal(false);
  protected readonly validName = this.profile.hasValidName;
  /** La tarjeta de apodo se muestra si al entrar no había apodo válido o si el jugador la abre. */
  protected readonly editingProfile = signal(!this.profile.hasValidName());

  protected readonly complete = computed(() => this.digits().length === LEN);
  protected readonly activeIndex = computed(() =>
    this.complete() || this.joining() ? -1 : this.digits().length,
  );
  protected readonly sessionCode = computed(() => this.store.session()?.code ?? null);
  protected readonly isRejoin = computed(
    () => this.complete() && this.sessionCode() === this.digits(),
  );
  protected readonly canSubmit = computed(
    () =>
      this.complete() &&
      !this.joining() &&
      (this.isRejoin() || (this.validName() && this.online())),
  );
  protected readonly srStatus = computed(() => {
    const d = this.digits();
    if (!d) {
      return 'Código vacío.';
    }
    const spoken = d.split('').join(' ');
    return d.length === LEN
      ? `Código completo: ${spoken}.`
      : `Código: ${spoken}. Faltan ${LEN - d.length} dígitos.`;
  });
  protected readonly formatRoomCode = formatRoomCode;

  constructor() {
    // Un enlace a la sala en la que ya estoy me devuelve a ella directamente.
    effect(() => {
      const code = onlyDigits(this.code() ?? '');
      untracked(() => {
        if (code.length === LEN && this.sessionCode() === code) {
          void this.router.navigate(['/sala', code], { replaceUrl: true });
        }
      });
    });
  }

  // ------------------------------------------------------------------ Entrada

  protected press(digit: string): void {
    this.sound.play('click');
    this.type(digit);
  }

  protected erase(): void {
    if (!this.joining()) {
      this.digits.update((d) => d.slice(0, -1));
    }
  }

  protected async pasteFromClipboard(): Promise<void> {
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      this.toast.show('No pudimos leer el portapapeles. Usa Ctrl+V o ⌘V.', 'info');
      return;
    }
    this.fill(text);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (
      event.defaultPrevented ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      isEditable(event.target)
    ) {
      return;
    }
    const key = event.key;
    if (/^\d$/.test(key)) {
      event.preventDefault();
      this.type(key);
    } else if (key === 'Backspace') {
      event.preventDefault();
      this.erase();
    } else if (key === 'Escape' || key === 'Delete') {
      if (!this.joining()) {
        this.digits.set('');
      }
    } else if (
      key === 'Enter' &&
      !(event.target instanceof Element && event.target.closest('button, a'))
    ) {
      // Enter sobre un botón enfocado ya activa ese botón.
      event.preventDefault();
      void this.submit();
    }
  }

  protected onPaste(event: ClipboardEvent): void {
    if (isEditable(event.target)) {
      return;
    }
    event.preventDefault();
    this.fill(event.clipboardData?.getData('text') ?? '');
  }

  // ------------------------------------------------------------------ Envío

  protected async submit(): Promise<void> {
    const code = this.digits();
    if (this.joining()) {
      return;
    }
    if (code.length !== LEN) {
      restartShake(this.boxes().nativeElement);
      return;
    }
    if (this.sessionCode() === code) {
      void this.router.navigate(['/sala', code]);
      return;
    }
    if (!this.validName()) {
      this.toast.show(this.profile.nameProblem() ?? 'Escribe tu apodo para entrar.', 'warning');
      this.showProfile(true);
      return;
    }
    if (!this.online()) {
      this.toast.show('Sin conexión con el servidor. Reintentando…', 'warning', 3200, 'wifi_off');
      return;
    }
    this.joining.set(true);
    try {
      const joined = await this.store.joinRoom(code);
      this.sound.play('join');
      await this.router.navigate(['/sala', joined]);
    } catch (err) {
      this.error.set(true);
      restartShake(this.boxes().nativeElement);
      this.toast.fromError(err);
      if (err instanceof Error && /apodo/i.test(err.message)) {
        this.showProfile(true);
      }
    } finally {
      this.joining.set(false);
    }
  }

  /** Abre la tarjeta de apodo; con `nudge` la sacude para llamar la atención. */
  protected showProfile(nudge = false): void {
    this.editingProfile.set(true);
    afterNextRender(
      () => {
        const card = this.profileCard();
        if (nudge) {
          card?.nudge();
        } else {
          card?.focusName();
        }
      },
      { injector: this.injector },
    );
  }

  private type(digit: string): void {
    if (this.joining() || this.complete()) {
      return;
    }
    this.digits.update((d) => d + digit);
    this.autoSubmit();
  }

  private fill(text: string): void {
    if (this.joining()) {
      return;
    }
    const code = extractCode(text);
    if (!code) {
      this.toast.show('Eso no parece un código de sala.', 'warning');
      return;
    }
    this.digits.set(code);
    this.autoSubmit();
  }

  /** Al completar el 6.º dígito se entra solo si ya hay un apodo válido. */
  private autoSubmit(): void {
    if (this.complete() && (this.isRejoin() || this.validName())) {
      void this.submit();
    }
  }
}
