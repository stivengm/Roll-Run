import { Injectable, signal } from '@angular/core';

export type ToastKind = 'info' | 'success' | 'error' | 'warning';

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  icon: string;
}

const ICONS: Record<ToastKind, string> = {
  info: 'info',
  success: 'check_circle',
  error: 'error',
  warning: 'warning',
};

/** Notificaciones efímeras. Las muestra `<app-toast-host>` (montado en el shell). */
@Injectable({ providedIn: 'root' })
export class ToastService {
  readonly toasts = signal<Toast[]>([]);
  private seq = 0;

  show(text: string, kind: ToastKind = 'info', durationMs = 3200, icon?: string): void {
    const toast: Toast = { id: ++this.seq, kind, text, icon: icon ?? ICONS[kind] };
    this.toasts.update((list) => [...list.slice(-2), toast]);
    setTimeout(() => this.dismiss(toast.id), durationMs);
  }

  success(text: string): void {
    this.show(text, 'success');
  }

  error(text: string): void {
    this.show(text, 'error', 4200);
  }

  /** Muestra el mensaje de un error lanzado por `SocketService.request`. */
  fromError(err: unknown): void {
    this.error(err instanceof Error ? err.message : 'Ocurrió un error inesperado.');
  }

  dismiss(id: number): void {
    this.toasts.update((list) => list.filter((t) => t.id !== id));
  }
}
