import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  input,
  untracked,
  viewChild,
} from '@angular/core';

export type DiceMood = 'idle' | 'penalty' | 'win';

interface Angles {
  x: number;
  y: number;
  z: number;
}

/** Rotación del cubo (X, Y) que deja cada cara de frente. Caras opuestas suman 7. */
const FACE_ANGLES: Record<number, { x: number; y: number }> = {
  1: { x: 0, y: 0 },
  2: { x: -90, y: 0 },
  3: { x: 0, y: -90 },
  4: { x: 0, y: 90 },
  5: { x: 90, y: 0 },
  6: { x: 0, y: 180 },
};

/** Debe coincidir con la animación `tumble` de dice.scss (duración y giro por ciclo). */
const TUMBLE_MS = 900;
const TUMBLE_TURN: Angles = { x: 720, y: 1080, z: 360 };
const SETTLE_MS = 760;
const SETTLE_EASE = 'cubic-bezier(0.18, 0.82, 0.28, 1)';
/** Vueltas extra al revelar un valor para que el dado siempre gire "hacia adelante". */
const EXTRA_SPIN = 720;

function toFace(value: number | null): number | null {
  return value !== null && Number.isInteger(value) && value >= 1 && value <= 6 ? value : null;
}

/** Menor ángulo >= `from` equivalente a `target` (mod 360). */
function forward(from: number, target: number): number {
  return from + ((((target - from) % 360) + 360) % 360);
}

function mod360(a: number): number {
  return ((a % 360) + 360) % 360;
}

function prefersReducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Dado 3D en CSS. Mientras `rolling` da tumbos sin parar; al revelar el valor frena con vueltas
 * extra hasta dejar esa cara de frente y aterriza con un pequeño rebote.
 */
@Component({
  selector: 'app-dice',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './dice.html',
  styleUrl: './dice.scss',
  host: {
    '[style.--dice]': 'size() + "px"',
  },
})
export class Dice {
  readonly value = input<number | null>(null);
  readonly rolling = input(false);
  /** Cara que castiga: se pinta con número rojo y calavera. */
  readonly penaltyNumber = input<number | null>(null);
  readonly mood = input<DiceMood>('idle');
  /** Arista del cubo en px. */
  readonly size = input(132);

  private readonly root = viewChild.required<ElementRef<HTMLElement>>('root');
  private readonly cube = viewChild.required<ElementRef<HTMLElement>>('cube');

  protected readonly faces = [1, 2, 3, 4, 5, 6] as const;
  private readonly face = computed(() => toFace(this.value()));

  protected readonly announcement = computed(() => {
    if (this.rolling()) {
      return 'Dado girando…';
    }
    const face = this.face();
    if (face === null) {
      return '';
    }
    return face === this.penaltyNumber() ? `Dado: ${face}. ¡Penitencia!` : `Dado: ${face}`;
  });

  /** Ángulos acumulados (sin normalizar) del último destino aplicado al cubo. */
  private angles: Angles = { x: 0, y: 180, z: 0 };
  private initialized = false;
  private wasRolling = false;
  private lastFace: number | null = null;
  /** Última cara en la que se asentó el cubo (para no inventar una al quedarse sin valor). */
  private shownFace: number | null = null;
  private tumbleStartedAt = 0;

  constructor() {
    afterRenderEffect(() => {
      const rolling = this.rolling();
      const face = this.face();
      untracked(() => this.sync(rolling, face));
    });
  }

  private sync(rolling: boolean, face: number | null): void {
    const cube = this.cube().nativeElement;
    if (!this.initialized) {
      this.initialized = true;
      const base = FACE_ANGLES[face ?? this.restFace()];
      this.shownFace = face;
      this.angles = { x: base.x, y: base.y, z: 0 };
      this.write(cube, this.angles, false);
      if (rolling) {
        this.startTumble(cube);
      }
    } else if (rolling && !this.wasRolling) {
      this.startTumble(cube);
    } else if (!rolling && this.wasRolling) {
      this.settle(cube, this.stopTumble(cube), face);
    } else if (!rolling && face !== null && face !== this.lastFace) {
      // Sin valor y sin girar no hay nada que mostrar: el cubo se queda en su cara.
      this.settle(cube, this.angles, face);
    }
    this.wasRolling = rolling;
    this.lastFace = face ?? this.lastFace;
  }

  private startTumble(cube: HTMLElement): void {
    const a = { x: mod360(this.angles.x), y: mod360(this.angles.y), z: mod360(this.angles.z) };
    this.angles = a;
    this.write(cube, a, false);
    cube.style.setProperty('--rx', `${a.x}deg`);
    cube.style.setProperty('--ry', `${a.y}deg`);
    cube.style.setProperty('--rz', `${a.z}deg`);
    this.root().nativeElement.classList.remove('landing');
    cube.classList.add('tumbling');
    this.tumbleStartedAt = performance.now();
  }

  /** Congela el cubo en la pose exacta en la que va la animación y la devuelve. */
  private stopTumble(cube: HTMLElement): Angles {
    const anim = cube.getAnimations().find((a) => a instanceof CSSAnimation);
    const time = anim?.currentTime;
    const elapsed = typeof time === 'number' ? time : performance.now() - this.tumbleStartedAt;
    const f = (elapsed % TUMBLE_MS) / TUMBLE_MS;
    const now = {
      x: this.angles.x + TUMBLE_TURN.x * f,
      y: this.angles.y + TUMBLE_TURN.y * f,
      z: this.angles.z + TUMBLE_TURN.z * f,
    };
    cube.classList.remove('tumbling');
    this.write(cube, now, false);
    return now;
  }

  private settle(cube: HTMLElement, from: Angles, face: number | null): void {
    const reduce = prefersReducedMotion();
    const base = FACE_ANGLES[face ?? this.shownFace ?? this.restFace()];
    this.shownFace = face ?? this.shownFace;
    const spin = face !== null && !reduce ? EXTRA_SPIN : 0;
    const target = {
      x: forward(from.x + spin, base.x),
      y: forward(from.y + spin, base.y),
      z: forward(from.z, 0),
    };
    // Fija el punto de partida antes de activar la transición.
    this.write(cube, from, false);
    void cube.offsetWidth;
    this.write(cube, target, !reduce);
    this.angles = target;
    if (face !== null && !reduce) {
      const root = this.root().nativeElement;
      root.classList.remove('landing');
      void root.offsetWidth;
      root.classList.add('landing');
    }
  }

  private write(cube: HTMLElement, a: Angles, animate: boolean): void {
    cube.style.transition = animate ? `transform ${SETTLE_MS}ms ${SETTLE_EASE}` : 'none';
    cube.style.transform = `rotateX(${a.x}deg) rotateY(${a.y}deg) rotateZ(${a.z}deg)`;
  }

  /** Cara de reposo cuando no hay valor: el 6, salvo que sea la penitencia. */
  private restFace(): number {
    return this.penaltyNumber() === 6 ? 5 : 6;
  }
}
