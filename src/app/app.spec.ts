import { reflectComponentType, type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  provideRouter,
  Router,
  UrlTree,
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
} from '@angular/router';
import {
  AVATARS,
  DEFAULT_SETTINGS,
  findAvatar,
  formatRoomCode,
  SETTINGS_LIMITS,
} from '../../shared/protocol';
import { App } from './app';
import { routes } from './app.routes';
import { confirmLeaveGuard } from './core/guards/leave.guard';
import { profileGuard } from './core/guards/profile.guard';
import { ProfileService } from './core/services/profile.service';
import { ToastService } from './core/services/toast.service';

describe('App', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [App],
      providers: [provideRouter([])],
    });
  });

  it('crea el shell con el router y el host de avisos', async () => {
    const fixture = TestBed.createComponent(App);
    await fixture.whenStable();
    const el = fixture.nativeElement as HTMLElement;

    expect(fixture.componentInstance).toBeTruthy();
    expect(el.querySelector('router-outlet')).not.toBeNull();
    expect(el.querySelector('app-toast-host')).not.toBeNull();
  });

  it('muestra los avisos del ToastService y permite cerrarlos', async () => {
    const fixture = TestBed.createComponent(App);
    const toasts = TestBed.inject(ToastService);
    toasts.show('¡Sala creada!', 'success');
    await fixture.whenStable();

    const el = fixture.nativeElement as HTMLElement;
    const toast = el.querySelector<HTMLElement>('.toast');
    expect(toast?.textContent).toContain('¡Sala creada!');
    expect(toast?.dataset['kind']).toBe('success');

    el.querySelector<HTMLButtonElement>('.toast button[aria-label="Cerrar aviso"]')?.click();
    await fixture.whenStable();
    expect(toasts.toasts()).toEqual([]);
  });
});

describe('Rutas', () => {
  it('declara las pantallas del juego', () => {
    expect(routes.map((r) => r.path)).toEqual([
      '',
      'crear',
      'unirse',
      'unirse/:code',
      'sala/:code',
      '**',
    ]);
  });

  it('cada ruta carga un componente standalone real', async () => {
    const selectors: string[] = [];
    for (const route of routes.filter((r) => r.loadComponent)) {
      const component = (await route.loadComponent!()) as Type<unknown>;
      const meta = reflectComponentType(component);
      expect(meta?.isStandalone).toBe(true);
      selectors.push(meta?.selector ?? '');
    }
    expect(selectors).toEqual([
      'app-home',
      'app-create-room',
      'app-join-room',
      'app-join-room',
      'app-room',
    ]);
  });

  it('/crear exige un apodo válido', () => {
    expect(routes.find((r) => r.path === 'crear')?.canActivate).toContain(profileGuard);
  });

  it('salir de /sala (atrás del navegador incluido) pasa por la confirmación de la sala', () => {
    expect(routes.find((r) => r.path === 'sala/:code')?.canDeactivate).toContain(
      confirmLeaveGuard,
    );
  });
});

describe('profileGuard', () => {
  const run = () =>
    TestBed.runInInjectionContext(() =>
      profileGuard({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot),
    );

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideRouter([])] });
  });

  it('sin apodo redirige al inicio y avisa', () => {
    const result = run();
    expect(result).toBeInstanceOf(UrlTree);
    expect(TestBed.inject(Router).serializeUrl(result as UrlTree)).toBe('/');
    expect(TestBed.inject(ToastService).toasts()[0]?.text).toBe(
      'Primero escribe tu apodo de jugador.',
    );
  });

  it('con apodo válido deja pasar', () => {
    TestBed.inject(ProfileService).setName('Stiven');
    expect(run()).toBe(true);
  });
});

describe('Contrato compartido', () => {
  it('formatea el código de sala en dos grupos de 3', () => {
    expect(formatRoomCode('882109')).toBe('882 · 109');
    expect(formatRoomCode('12345')).toBe('12345');
    expect(formatRoomCode('')).toBe('');
  });

  it('findAvatar cae en el primer avatar con ids desconocidos', () => {
    expect(findAvatar('robot').icon).toBe('smart_toy');
    expect(findAvatar('no-existe')).toBe(AVATARS[0]);
    expect(findAvatar(null)).toBe(AVATARS[0]);
    expect(new Set(AVATARS.map((a) => a.id)).size).toBe(AVATARS.length);
  });

  it('la configuración por defecto respeta los límites', () => {
    const { targetScore, penaltyNumber, maxPlayers } = SETTINGS_LIMITS;
    expect(DEFAULT_SETTINGS.targetScore).toBeGreaterThanOrEqual(targetScore.min);
    expect(DEFAULT_SETTINGS.targetScore).toBeLessThanOrEqual(targetScore.max);
    expect(DEFAULT_SETTINGS.targetScore % targetScore.step).toBe(0);
    expect(DEFAULT_SETTINGS.penaltyNumber).toBeGreaterThanOrEqual(penaltyNumber.min);
    expect(DEFAULT_SETTINGS.penaltyNumber).toBeLessThanOrEqual(penaltyNumber.max);
    expect(DEFAULT_SETTINGS.maxPlayers).toBeGreaterThanOrEqual(maxPlayers.min);
    expect(DEFAULT_SETTINGS.maxPlayers).toBeLessThanOrEqual(maxPlayers.max);
    expect(DEFAULT_SETTINGS.penaltyMode).toBe('all');
  });
});
