import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { ProfileService } from '../services/profile.service';
import { ToastService } from '../services/toast.service';

/** Exige un apodo válido antes de crear una sala. */
export const profileGuard: CanActivateFn = () => {
  if (inject(ProfileService).hasValidName()) {
    return true;
  }
  inject(ToastService).show('Primero escribe tu apodo de jugador.', 'warning');
  return inject(Router).createUrlTree(['/']);
};
