import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import {
  provideRouter,
  withComponentInputBinding,
  withInMemoryScrolling,
  withRouterConfig,
} from '@angular/router';

import { routes } from './app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // Cada pantalla nueva empieza arriba (sin heredar el scroll de la anterior).
    provideRouter(
      routes,
      withComponentInputBinding(),
      withInMemoryScrolling({ scrollPositionRestoration: 'top' }),
      // Al cancelar un "atrás" (salir de la sala sin confirmar) el historial queda como estaba.
      withRouterConfig({ canceledNavigationResolution: 'computed' }),
    ),
  ],
};
