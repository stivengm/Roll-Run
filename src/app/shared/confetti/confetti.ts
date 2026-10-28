import {
  afterRenderEffect,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  input,
  NgZone,
  untracked,
  viewChild,
} from '@angular/core';

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  w: number;
  h: number;
  rot: number;
  vr: number;
  flip: number;
  vf: number;
  wobble: number;
  color: string;
  round: boolean;
}

const COLORS = ['#ffd700', '#ffe16d', '#fd8b00', '#ffb77d', '#00f1fe', '#74f5ff', '#ffffff'];
const GRAVITY = 0.22;
const DRAG = 0.985;
const MAX_FALL = 5.5;
const FADE_MS = 900;

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** Ráfaga de confeti en un canvas a pantalla completa (no captura clics). */
@Component({
  selector: 'app-confetti',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './confetti.html',
  styleUrl: './confetti.scss',
  host: {
    '(window:resize)': 'resize()',
  },
})
export class Confetti {
  readonly active = input(true);
  readonly durationMs = input(4500);

  private readonly canvas = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly zone = inject(NgZone);

  private ctx: CanvasRenderingContext2D | null = null;
  private particles: Particle[] = [];
  private frame = 0;
  private startedAt = 0;
  private lastTick = 0;
  private duration = 4500;
  private width = 0;
  private height = 0;

  constructor() {
    afterRenderEffect(() => {
      const active = this.active();
      const duration = this.durationMs();
      untracked(() => (active ? this.start(duration) : this.stop()));
    });
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  protected resize(): void {
    const canvas = this.canvas().nativeElement;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.width = window.innerWidth;
    this.height = window.innerHeight;
    canvas.width = Math.round(this.width * dpr);
    canvas.height = Math.round(this.height * dpr);
    this.ctx = canvas.getContext('2d');
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private start(duration: number): void {
    this.stop();
    if (typeof window === 'undefined' || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return;
    }
    this.resize();
    if (!this.ctx) {
      return;
    }
    this.duration = Math.max(1200, duration);
    this.particles = [];
    this.cannon(true);
    this.cannon(false);
    this.startedAt = this.lastTick = performance.now();
    this.zone.runOutsideAngular(() => {
      this.frame = requestAnimationFrame((t) => this.tick(t));
    });
  }

  private stop(): void {
    if (this.frame) {
      cancelAnimationFrame(this.frame);
      this.frame = 0;
    }
    this.particles = [];
    this.ctx?.clearRect(0, 0, this.width, this.height);
  }

  /** Cañón desde una esquina inferior apuntando hacia el centro. */
  private cannon(fromLeft: boolean): void {
    const count = Math.round(Math.min(90, Math.max(50, this.width / 8)));
    for (let i = 0; i < count; i++) {
      const angle = rand(55, 78) * (Math.PI / 180);
      const speed = rand(10, 19) * Math.min(1.25, Math.max(0.85, this.height / 800));
      this.particles.push(
        this.particle(
          fromLeft ? -10 : this.width + 10,
          this.height * 0.9,
          Math.cos(angle) * speed * (fromLeft ? 1 : -1),
          -Math.sin(angle) * speed,
        ),
      );
    }
  }

  private particle(x: number, y: number, vx: number, vy: number): Particle {
    return {
      x,
      y,
      vx,
      vy,
      w: rand(6, 11),
      h: rand(9, 16),
      rot: rand(0, Math.PI * 2),
      vr: rand(-0.2, 0.2),
      flip: rand(0, Math.PI * 2),
      vf: rand(0.08, 0.2),
      wobble: rand(0, Math.PI * 2),
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      round: Math.random() < 0.25,
    };
  }

  private tick(now: number): void {
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }
    const elapsed = now - this.startedAt;
    const dt = Math.min(3, (now - this.lastTick) / 16.67);
    this.lastTick = now;

    // Lluvia suave desde arriba durante la primera mitad.
    if (elapsed < this.duration * 0.5) {
      for (let i = 0; i < 2; i++) {
        this.particles.push(this.particle(rand(0, this.width), -16, rand(-1, 1), rand(1, 3)));
      }
    }

    const fadeStart = this.duration - FADE_MS;
    const alpha = elapsed > fadeStart ? Math.max(0, 1 - (elapsed - fadeStart) / FADE_MS) : 1;

    ctx.clearRect(0, 0, this.width, this.height);
    ctx.globalAlpha = alpha;
    const alive: Particle[] = [];
    for (const p of this.particles) {
      p.vx *= Math.pow(DRAG, dt);
      p.vy = Math.min(MAX_FALL, p.vy * Math.pow(DRAG, dt) + GRAVITY * dt);
      p.wobble += 0.12 * dt;
      p.x += (p.vx + Math.sin(p.wobble) * 0.8) * dt;
      p.y += p.vy * dt;
      p.rot += p.vr * dt;
      p.flip += p.vf * dt;
      if (p.y > this.height + 30 || p.x < -60 || p.x > this.width + 60) {
        continue;
      }
      alive.push(p);
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.scale(1, Math.cos(p.flip));
      ctx.fillStyle = p.color;
      if (p.round) {
        ctx.beginPath();
        ctx.arc(0, 0, p.w / 2, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
    this.particles = alive;

    if (elapsed >= this.duration || (alive.length === 0 && elapsed > this.duration * 0.5)) {
      this.stop();
      return;
    }
    this.frame = requestAnimationFrame((t) => this.tick(t));
  }
}
