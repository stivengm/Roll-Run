import { Injectable, signal } from '@angular/core';
import { TIMINGS } from '../../../../shared/protocol';

export type SoundName = 'click' | 'roll' | 'land' | 'gain' | 'penalty' | 'win' | 'turn' | 'join';

const STORAGE_KEY = 'rr.muted';
const MASTER_VOLUME = 0.32;
const UNLOCK_EVENTS = ['pointerdown', 'touchend', 'click', 'keydown'] as const;
/** Si el contexto tarda más que esto en reanudarse, el sonido ya llegaría tarde: se descarta. */
const LATE_MS = 200;

interface ToneOptions {
  at: number;
  freq: number;
  /** Frecuencia final (rampa exponencial). */
  to?: number;
  dur: number;
  gain: number;
  type?: OscillatorType;
  attack?: number;
}

interface NoiseOptions {
  at: number;
  dur: number;
  gain: number;
  freq: number;
  q?: number;
  filter?: BiquadFilterType;
}

type AudioContextCtor = typeof AudioContext;

function readMuted(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Efectos de sonido sintetizados con WebAudio (sin archivos). El AudioContext se crea de forma
 * perezosa y se reanuda con el primer gesto del usuario; cualquier fallo se ignora en silencio.
 */
@Injectable({ providedIn: 'root' })
export class SoundService {
  readonly muted = signal(readMuted());

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private listening = false;
  /** Último momento (performance.now) en que se pidió cada sonido. */
  private readonly lastPlayed = new Map<SoundName, number>();

  private readonly unlock = (): void => {
    if (this.muted()) {
      return;
    }
    const ctx = this.context(true);
    if (!ctx) {
      return;
    }
    if (ctx.state === 'running') {
      this.detachUnlock();
      return;
    }
    ctx
      .resume()
      .then(() => ctx.state === 'running' && this.detachUnlock())
      .catch(() => undefined);
  };

  constructor() {
    if (typeof document !== 'undefined') {
      this.listening = true;
      for (const type of UNLOCK_EVENTS) {
        document.addEventListener(type, this.unlock, { capture: true, passive: true });
      }
    }
  }

  /** `minGapMs`: si el mismo sonido se pidió hace menos de ese tiempo, no se repite. */
  play(name: SoundName, minGapMs = 0): void {
    if (this.muted()) {
      return;
    }
    const now = performance.now();
    if (minGapMs > 0 && now - (this.lastPlayed.get(name) ?? -Infinity) < minGapMs) {
      return;
    }
    this.lastPlayed.set(name, now);
    try {
      const ctx = this.context(false);
      if (!ctx) {
        return;
      }
      if (ctx.state === 'running') {
        this.schedule(name, ctx);
        return;
      }
      const requestedAt = performance.now();
      ctx
        .resume()
        .then(() => {
          if (ctx.state === 'running' && performance.now() - requestedAt < LATE_MS) {
            this.schedule(name, ctx);
          }
        })
        .catch(() => undefined);
    } catch {
      // El audio nunca debe romper el juego.
    }
  }

  toggle(): void {
    const muted = !this.muted();
    this.muted.set(muted);
    try {
      localStorage.setItem(STORAGE_KEY, muted ? '1' : '0');
    } catch {
      // Sin almacenamiento: la preferencia vive solo en memoria.
    }
    if (!muted) {
      // toggle() se llama desde un gesto: buen momento para crear/reanudar el contexto.
      this.unlock();
    }
  }

  // ------------------------------------------------------------------ Contexto

  /** Crea el contexto solo dentro de un gesto (o si la página ya tuvo uno) para evitar avisos. */
  private context(fromGesture: boolean): AudioContext | null {
    if (this.ctx) {
      return this.ctx;
    }
    if (typeof window === 'undefined') {
      return null;
    }
    const activated =
      fromGesture || (typeof navigator !== 'undefined' && navigator.userActivation?.hasBeenActive);
    if (!activated) {
      return null;
    }
    const Ctor: AudioContextCtor | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
    if (!Ctor) {
      return null;
    }
    try {
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = MASTER_VOLUME;
      master.connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
      return ctx;
    } catch {
      return null;
    }
  }

  private detachUnlock(): void {
    if (!this.listening) {
      return;
    }
    this.listening = false;
    for (const type of UNLOCK_EVENTS) {
      document.removeEventListener(type, this.unlock, { capture: true });
    }
  }

  private schedule(name: SoundName, ctx: AudioContext): void {
    try {
      const t = ctx.currentTime + 0.01;
      switch (name) {
        case 'click':
          this.tone(ctx, { at: t, freq: 1500, to: 900, dur: 0.05, gain: 0.14, type: 'square' });
          break;
        case 'roll':
          this.roll(ctx, t);
          break;
        case 'land':
          this.tone(ctx, { at: t, freq: 170, to: 55, dur: 0.24, gain: 0.75 });
          this.burst(ctx, { at: t, dur: 0.07, gain: 0.45, freq: 900, filter: 'lowpass' });
          break;
        case 'gain':
          this.tone(ctx, { at: t, freq: 520, to: 1040, dur: 0.16, gain: 0.3, type: 'triangle' });
          this.tone(ctx, { at: t + 0.08, freq: 1040, to: 1560, dur: 0.16, gain: 0.16 });
          break;
        case 'penalty':
          this.tone(ctx, { at: t, freq: 330, to: 65, dur: 0.75, gain: 0.2, type: 'sawtooth' });
          this.tone(ctx, { at: t, freq: 336, to: 62, dur: 0.75, gain: 0.14, type: 'square' });
          this.tone(ctx, { at: t, freq: 110, to: 40, dur: 0.6, gain: 0.35 });
          break;
        case 'win':
          this.win(ctx, t);
          break;
        case 'turn':
          this.tone(ctx, { at: t, freq: 1318.5, dur: 0.9, gain: 0.22, attack: 0.004 });
          this.tone(ctx, { at: t, freq: 2637, dur: 0.45, gain: 0.05, attack: 0.004 });
          this.tone(ctx, { at: t + 0.13, freq: 1568, dur: 0.9, gain: 0.18, attack: 0.004 });
          break;
        case 'join':
          this.tone(ctx, { at: t, freq: 260, to: 720, dur: 0.11, gain: 0.3, attack: 0.004 });
          break;
      }
    } catch {
      // Ignorar: un nodo que falla no debe afectar al juego.
    }
  }

  // ------------------------------------------------------------------ Voces

  /** Traqueteo: clics de ruido filtrado a intervalos irregulares durante el giro. */
  private roll(ctx: AudioContext, t: number): void {
    const seconds = TIMINGS.rollMs / 1000;
    const count = Math.round(TIMINGS.rollMs / 70);
    for (let i = 0; i < count; i++) {
      const at = t + (i / count) * seconds + rand(0, 0.03);
      const fade = 1 - (i / count) * 0.5;
      this.burst(ctx, {
        at,
        dur: rand(0.025, 0.045),
        gain: rand(0.25, 0.45) * fade,
        freq: rand(1800, 4200),
        q: 4,
      });
      if (i % 4 === 0) {
        this.tone(ctx, {
          at,
          freq: rand(260, 340),
          dur: 0.04,
          gain: 0.08 * fade,
          type: 'triangle',
        });
      }
    }
  }

  /** Fanfarria corta: arpegio ascendente y acorde final. */
  private win(ctx: AudioContext, t: number): void {
    [523.25, 659.25, 783.99].forEach((freq, i) =>
      this.tone(ctx, { at: t + i * 0.11, freq, dur: 0.18, gain: 0.26, type: 'triangle' }),
    );
    [659.25, 783.99, 1046.5].forEach((freq) =>
      this.tone(ctx, { at: t + 0.36, freq, dur: 0.8, gain: 0.16, type: 'triangle' }),
    );
    this.tone(ctx, { at: t + 0.36, freq: 2093, dur: 0.45, gain: 0.05 });
  }

  private tone(ctx: AudioContext, o: ToneOptions): void {
    if (!this.master) {
      return;
    }
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.freq, o.at);
    if (o.to) {
      osc.frequency.exponentialRampToValueAtTime(o.to, o.at + o.dur);
    }
    env.gain.setValueAtTime(0.0001, o.at);
    env.gain.exponentialRampToValueAtTime(o.gain, o.at + (o.attack ?? 0.008));
    env.gain.exponentialRampToValueAtTime(0.0001, o.at + o.dur);
    osc.connect(env).connect(this.master);
    osc.onended = () => {
      osc.disconnect();
      env.disconnect();
    };
    osc.start(o.at);
    osc.stop(o.at + o.dur + 0.02);
  }

  private burst(ctx: AudioContext, o: NoiseOptions): void {
    if (!this.master) {
      return;
    }
    this.noise ??= this.createNoise(ctx);
    const src = ctx.createBufferSource();
    const filter = ctx.createBiquadFilter();
    const env = ctx.createGain();
    src.buffer = this.noise;
    filter.type = o.filter ?? 'bandpass';
    filter.frequency.value = o.freq;
    filter.Q.value = o.q ?? 1;
    env.gain.setValueAtTime(0.0001, o.at);
    env.gain.exponentialRampToValueAtTime(o.gain, o.at + 0.003);
    env.gain.exponentialRampToValueAtTime(0.0001, o.at + o.dur);
    src.connect(filter).connect(env).connect(this.master);
    src.onended = () => {
      src.disconnect();
      filter.disconnect();
      env.disconnect();
    };
    src.start(o.at, rand(0, 0.9));
    src.stop(o.at + o.dur + 0.02);
  }

  private createNoise(ctx: AudioContext): AudioBuffer {
    const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    return buffer;
  }
}
