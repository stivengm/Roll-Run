import { TestBed } from '@angular/core/testing';
import { ToastService } from './toast.service';

describe('ToastService', () => {
  let service: ToastService;

  beforeEach(() => {
    vi.useFakeTimers();
    service = TestBed.inject(ToastService);
  });

  afterEach(() => vi.useRealTimers());

  it('cierra cada aviso al cumplir su duración', () => {
    service.show('Hola', 'info', 1000);
    expect(service.toasts()).toHaveLength(1);
    expect(service.toasts()[0]).toMatchObject({ text: 'Hola', kind: 'info', icon: 'info' });

    vi.advanceTimersByTime(999);
    expect(service.toasts()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(service.toasts()).toHaveLength(0);
  });

  it('muestra como máximo 3 avisos a la vez', () => {
    ['a', 'b', 'c', 'd'].forEach((text) => service.show(text));
    expect(service.toasts().map((t) => t.text)).toEqual(['b', 'c', 'd']);
  });

  it('fromError usa el mensaje del servidor o uno genérico', () => {
    service.fromError(new Error('No es tu turno.'));
    service.fromError('raro');
    expect(service.toasts().map((t) => [t.kind, t.text])).toEqual([
      ['error', 'No es tu turno.'],
      ['error', 'Ocurrió un error inesperado.'],
    ]);
  });
});
