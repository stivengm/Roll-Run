import type { CanDeactivateFn } from '@angular/router';

/** Pantalla que decide si se puede salir de ella (y, si no, pide confirmación a su manera). */
export interface ConfirmLeave {
  canLeave(): boolean;
}

/**
 * Cubre las salidas que no pasan por la flecha de la barra: atrás del navegador, gesto atrás
 * de Android o enlaces. Requiere `canceledNavigationResolution: 'computed'` en el router para
 * que cancelar un "atrás" no desordene el historial.
 */
export const confirmLeaveGuard: CanDeactivateFn<ConfirmLeave> = (component) =>
  component?.canLeave() ?? true;
