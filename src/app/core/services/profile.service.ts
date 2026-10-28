import { computed, Injectable, signal } from '@angular/core';
import {
  AVATARS,
  cleanName,
  DEFAULT_AVATAR_ID,
  NAME_LIMITS,
  nameError,
  type PlayerProfile,
} from '../../../../shared/protocol';

const STORAGE_KEY = 'rr.profile';

const NICK_PREFIXES = [
  'Dado',
  'Rey',
  'Turbo',
  'Rayo',
  'Ninja',
  'Cohete',
  'Tigre',
  'Capi',
  'Lobo',
  'Pixel',
  'Neon',
  'Bala',
];
const NICK_SUFFIXES = [
  'Veloz',
  'Loco',
  'Del6',
  'Suertudo',
  'Runner',
  'Roller',
  'Turbo',
  'Furioso',
  'Maestro',
  'Fugaz',
  'Arcade',
  'Bravo',
];

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

/** Misma limpieza que aplica el servidor al recibir el apodo. */
export function sanitizeName(raw: string): string {
  return cleanName(raw);
}

/** Motivo por el que el servidor rechazaría el apodo, o `null` si es válido. */
export function nameProblem(raw: string): string | null {
  return nameError(cleanName(raw));
}

export function isValidName(raw: string): boolean {
  return nameProblem(raw) === null;
}

/** Perfil local del jugador (apodo + avatar). Se guarda en localStorage entre visitas. */
@Injectable({ providedIn: 'root' })
export class ProfileService {
  readonly profile = signal<PlayerProfile>(this.load());
  readonly nameProblem = computed(() => nameProblem(this.profile().name));
  readonly hasValidName = computed(() => this.nameProblem() === null);

  setName(name: string): void {
    this.update({ name: name.slice(0, NAME_LIMITS.max) });
  }

  setAvatar(avatar: string): void {
    if (AVATARS.some((a) => a.id === avatar)) {
      this.update({ avatar });
    }
  }

  randomName(): string {
    const name = `${pick(NICK_PREFIXES)}_${pick(NICK_SUFFIXES)}${Math.floor(Math.random() * 90 + 10)}`;
    this.setName(name);
    return name;
  }

  /** Perfil listo para enviar al servidor (nombre saneado). */
  snapshot(): PlayerProfile {
    const { name, avatar } = this.profile();
    return { name: sanitizeName(name), avatar };
  }

  private update(patch: Partial<PlayerProfile>): void {
    this.profile.update((p) => ({ ...p, ...patch }));
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.profile()));
    } catch {
      // Almacenamiento no disponible (modo privado): el perfil vive solo en memoria.
    }
  }

  private load(): PlayerProfile {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as PlayerProfile | null;
      if (saved && typeof saved.name === 'string') {
        return {
          name: saved.name.slice(0, NAME_LIMITS.max),
          avatar: AVATARS.some((a) => a.id === saved.avatar) ? saved.avatar : DEFAULT_AVATAR_ID,
        };
      }
    } catch {
      // Ignorar datos corruptos.
    }
    return { name: '', avatar: pick(AVATARS).id };
  }
}
