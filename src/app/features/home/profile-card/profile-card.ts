import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { AVATARS, findAvatar, NAME_LIMITS } from '../../../../../shared/protocol';
import { ProfileService, sanitizeName } from '../../../core/services/profile.service';
import { SoundService } from '../../../core/services/sound.service';
import { Avatar } from '../../../shared/avatar/avatar';

let nextId = 0;

function radioIndex(key: string, index: number, count: number): number | null {
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (index + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (index - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

/** Vuelve a disparar la animación global `.anim-shake` aunque ya se esté reproduciendo. */
export function restartShake(el: HTMLElement): void {
  el.classList.remove('anim-shake');
  void el.offsetWidth;
  el.classList.add('anim-shake');
  el.addEventListener('animationend', () => el.classList.remove('anim-shake'), { once: true });
}

/** Tarjeta "Pasaporte arcade": apodo y avatar del jugador, enlazados a `ProfileService`. */
@Component({
  selector: 'app-profile-card',
  imports: [Avatar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './profile-card.html',
  styleUrl: './profile-card.scss',
  host: { '[class.compact]': 'compact()' },
})
export class ProfileCard {
  private readonly profileService = inject(ProfileService);
  private readonly sound = inject(SoundService);

  /** Variante más baja (pantalla de unirse). */
  readonly compact = input(false);

  private readonly card = viewChild.required<ElementRef<HTMLElement>>('card');
  private readonly nameInput = viewChild.required<ElementRef<HTMLInputElement>>('nameInput');
  private readonly avatarRow = viewChild.required<ElementRef<HTMLElement>>('avatarRow');

  protected readonly avatars = AVATARS;
  protected readonly limits = NAME_LIMITS;
  private readonly uid = ++nextId;
  protected readonly ids = {
    name: `rr-nick-${this.uid}`,
    hint: `rr-nick-hint-${this.uid}`,
    avatars: `rr-avatars-${this.uid}`,
  };

  protected readonly profile = this.profileService.profile;
  protected readonly selected = computed(() => findAvatar(this.profile().avatar));
  /** El aviso de apodo inválido aparece solo tras escribir algo o tras un `nudge()`. */
  private readonly touched = signal(false);
  protected readonly showError = computed(
    () => this.touched() && !this.profileService.hasValidName(),
  );
  protected readonly problem = this.profileService.nameProblem;

  constructor() {
    afterNextRender(() => this.centerSelected('instant'));
  }

  /** Llama la atención sobre el apodo: sacude la tarjeta y enfoca el campo. */
  nudge(): void {
    this.touched.set(true);
    restartShake(this.card().nativeElement);
    this.focusName();
  }

  focusName(): void {
    const el = this.nameInput().nativeElement;
    el.focus();
    el.select();
  }

  protected onName(event: Event): void {
    this.profileService.setName((event.target as HTMLInputElement).value);
  }

  protected onBlur(): void {
    const name = this.profile().name;
    if (name) {
      this.touched.set(true);
      const clean = sanitizeName(name);
      if (clean !== name) {
        this.profileService.setName(clean);
      }
    }
  }

  protected random(): void {
    this.profileService.randomName();
    this.touched.set(true);
    this.sound.play('click');
  }

  protected pick(id: string): void {
    if (id !== this.profile().avatar) {
      this.profileService.setAvatar(id);
      this.sound.play('click');
    }
    this.centerSelected('smooth');
  }

  /** Radiogroup con foco itinerante: flechas, Inicio y Fin cambian el avatar. */
  protected onAvatarKey(event: KeyboardEvent): void {
    const index = this.avatars.findIndex((a) => a.id === this.profile().avatar);
    const next = radioIndex(event.key, index, this.avatars.length);
    if (next === null) {
      return;
    }
    event.preventDefault();
    this.pick(this.avatars[next].id);
    this.avatarRow().nativeElement.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
  }

  private centerSelected(behavior: ScrollBehavior): void {
    const row = this.avatarRow().nativeElement;
    const index = this.avatars.findIndex((a) => a.id === this.profile().avatar);
    const btn = row.querySelectorAll<HTMLElement>('button')[index];
    if (btn) {
      row.scrollTo({ left: btn.offsetLeft - (row.clientWidth - btn.offsetWidth) / 2, behavior });
    }
  }
}
