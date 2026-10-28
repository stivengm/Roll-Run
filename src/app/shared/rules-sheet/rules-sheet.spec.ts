import { TestBed } from '@angular/core/testing';
import { DEFAULT_SETTINGS, type RoomSettings } from '../../../../shared/protocol';
import { RulesSheet } from './rules-sheet';

async function render(settings: RoomSettings, defaults: boolean): Promise<string> {
  const fixture = TestBed.createComponent(RulesSheet);
  fixture.componentRef.setInput('open', true);
  fixture.componentRef.setInput('settings', settings);
  fixture.componentRef.setInput('defaults', defaults);
  await fixture.whenStable();
  return ((fixture.nativeElement as HTMLElement).textContent ?? '').replace(/\s+/g, ' ');
}

describe('RulesSheet', () => {
  it('en el inicio presenta los valores como reglas por defecto configurables', async () => {
    const text = await render(DEFAULT_SETTINGS, true);

    expect(text).toContain('Reglas por defecto');
    expect(text).toContain('El anfitrión elige la meta, el número de penitencia');
    expect(text).toContain('Cuidado con la penitencia');
    expect(text).toContain('por defecto, el 1');
    expect(text).toContain('Llega a la meta');
    expect(text).not.toContain('Cuidado con el 1');
  });

  it('dentro de la sala muestra las reglas reales sin la nota de valores por defecto', async () => {
    const text = await render(
      { targetScore: 30, penaltyNumber: 6, penaltyMode: 'turn', maxPlayers: 4 },
      false,
    );

    expect(text).toContain('Meta 30 pts');
    expect(text).toContain('Cuidado con el 6');
    expect(text).toContain('Llega a 30 pts');
    expect(text).toContain('Si sale el 6, pierdes los puntos que sumaste en ese turno');
    expect(text).not.toContain('por defecto');
    expect(text).not.toContain('anfitrión elige');
  });
});
