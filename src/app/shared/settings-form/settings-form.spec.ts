import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DEFAULT_SETTINGS, type RoomSettings } from '../../../../shared/protocol';
import { SettingsForm } from './settings-form';

@Component({
  imports: [SettingsForm],
  template: `
    <form (submit)="$event.preventDefault(); submitted = submitted + 1">
      <app-settings-form [(settings)]="settings" />
      <button type="submit">Crear sala</button>
    </form>
  `,
})
class Host {
  readonly settings = signal<RoomSettings>({ ...DEFAULT_SETTINGS });
  submitted = 0;
}

describe('SettingsForm', () => {
  it('Enter en la meta confirma el número sin enviar el formulario', async () => {
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const input = (fixture.nativeElement as HTMLElement).querySelector<HTMLInputElement>(
      '.score-input',
    )!;
    expect(input.getAttribute('enterkeyhint')).toBe('done');

    input.value = '103';
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    await fixture.whenStable();

    // Sin preventDefault, el navegador haría el envío implícito (crear sala / guardar reglas).
    expect(enter.defaultPrevented).toBe(true);
    expect(fixture.componentInstance.settings().targetScore).toBe(105);
    expect(input.value).toBe('105');
    expect(fixture.componentInstance.submitted).toBe(0);
  });
});
