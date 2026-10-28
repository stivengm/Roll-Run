import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  input,
  output,
  untracked,
  viewChild,
} from '@angular/core';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let nextId = 0;
/** Hojas abiertas a la vez (para bloquear/desbloquear el scroll del body una sola vez). */
let openSheets = 0;

/**
 * Bottom sheet en móvil y modal centrado desde 600px. El padre controla `open` y lo pone en
 * `false` al recibir `closed` (backdrop, botón X o Escape).
 */
@Component({
  selector: 'app-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './sheet.html',
  styleUrl: './sheet.scss',
  host: {
    '(document:keydown.escape)': 'onEscape()',
  },
})
export class Sheet {
  readonly open = input(false);
  readonly title = input('');
  /** Ícono de Material Symbols junto al título. */
  readonly icon = input<string | null>(null);
  readonly closed = output<void>();

  protected readonly titleId = `rr-sheet-title-${++nextId}`;
  private readonly panel = viewChild<ElementRef<HTMLElement>>('panel');
  private returnFocus: HTMLElement | null = null;
  private locked = false;

  constructor() {
    effect(() => {
      const isOpen = this.open();
      untracked(() => (isOpen ? this.lockScroll() : this.unlockScroll()));
    });

    // Al abrir enfoca el panel; al cerrar devuelve el foco a quien lo abrió.
    afterRenderEffect(() => {
      const panel = this.panel()?.nativeElement;
      untracked(() => {
        if (panel) {
          if (!panel.contains(document.activeElement)) {
            this.returnFocus ??= document.activeElement as HTMLElement | null;
            panel.focus({ preventScroll: true });
          }
        } else if (this.returnFocus) {
          const target = this.returnFocus;
          this.returnFocus = null;
          target.focus?.({ preventScroll: true });
        }
      });
    });

    inject(DestroyRef).onDestroy(() => this.unlockScroll());
  }

  protected requestClose(): void {
    this.closed.emit();
  }

  protected onEscape(): void {
    if (this.open()) {
      this.closed.emit();
    }
  }

  /** Mantiene el foco dentro del diálogo con Tab / Shift+Tab. */
  protected onKeydown(event: KeyboardEvent): void {
    const panel = this.panel()?.nativeElement;
    if (event.key !== 'Tab' || !panel) {
      return;
    }
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null,
    );
    if (items.length === 0) {
      event.preventDefault();
      return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  }

  private lockScroll(): void {
    if (this.locked || typeof document === 'undefined') {
      return;
    }
    this.locked = true;
    if (openSheets++ === 0) {
      document.body.style.overflow = 'hidden';
    }
  }

  private unlockScroll(): void {
    if (!this.locked) {
      return;
    }
    this.locked = false;
    if (--openSheets === 0) {
      document.body.style.overflow = '';
    }
  }
}
