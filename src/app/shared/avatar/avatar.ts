import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { findAvatar } from '../../../../shared/protocol';

export type AvatarRing = 'none' | 'yellow' | 'cyan' | 'red';

/** Avatar de ícono: tile glossy con el color del avatar, anillo, estado online e insignia de anfitrión. */
@Component({
  selector: 'app-avatar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './avatar.html',
  styleUrl: './avatar.scss',
  host: {
    role: 'img',
    '[attr.aria-label]': 'ariaLabel()',
    '[attr.data-ring]': 'ring()',
    '[class.dimmed]': 'dimmed()',
    '[style.--av-size]': 'size() + "px"',
    '[style.--av-color]': 'option().color',
  },
})
export class Avatar {
  /** Id de `AVATARS`; si no existe se usa el primero. */
  readonly avatar = input<string>('');
  /** Lado en px. */
  readonly size = input(48);
  readonly ring = input<AvatarRing>('none');
  /** Punto de estado abajo a la derecha: verde online, gris offline, oculto si es `null`. */
  readonly online = input<boolean | null>(null);
  /** Insignia de anfitrión (estrella). */
  readonly host = input(false);
  /** Escala de grises (jugador desconectado, eliminado…). */
  readonly dimmed = input(false);
  /** Texto accesible opcional; por defecto se usa el nombre del avatar. */
  readonly label = input<string | null>(null);

  protected readonly option = computed(() => findAvatar(this.avatar()));

  protected readonly ariaLabel = computed(() => {
    const parts = [this.label() ?? `Avatar ${this.option().label}`];
    if (this.host()) {
      parts.push('anfitrión');
    }
    const online = this.online();
    if (online !== null) {
      parts.push(online ? 'conectado' : 'desconectado');
    }
    return parts.join(', ');
  });
}
