// Web Audio playback on the audio clock. "Song time" = seconds into the audio file being heard
// (output latency removed); the calibration offsets in settings handle what's left.

let ctx: AudioContext | null = null;
export function audioCtx(): AudioContext {
  if (!ctx) ctx = new AudioContext({ latencyHint: "interactive" });
  return ctx;
}

/** ctx.currentTime minus the device's reported output latency. */
export function heardNow(): number {
  const c = audioCtx();
  return c.currentTime - (c.outputLatency || 0) - (c.baseLatency || 0);
}

/** Audio-clock time (heard) at which a keyboard event happened. */
export function heardAt(e: { timeStamp: number }): number {
  const ago = Math.max(0, performance.now() - e.timeStamp) / 1000;
  return heardNow() - ago;
}

const cache = new Map<string, Promise<AudioBuffer>>();
export function loadBuffer(url: string): Promise<AudioBuffer> {
  let p = cache.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`could not load ${url}`);
        return r.arrayBuffer();
      })
      .then((b) => audioCtx().decodeAudioData(b));
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return p;
}

/** What the play screen needs from a song player: positions are "real" seconds (at the chosen speed). */
export interface GamePlayer {
  readonly duration: number;
  readonly playing: boolean;
  onEnded: (() => void) | null;
  play(from?: number, delay?: number): void;
  time(): number;
  timeOf(e: { timeStamp: number }): number;
  pause(): void;
  resume(delay?: number): void;
  stop(): void;
  dispose(): void;
}

export class Player implements GamePlayer {
  private src: AudioBufferSourceNode | null = null;
  private gain: GainNode;
  private startAt = 0; // heard-clock time of song position 0
  private pausedAt: number | null = null;
  onEnded: (() => void) | null = null;

  constructor(readonly buffer: AudioBuffer, volume = 0.8) {
    this.gain = audioCtx().createGain();
    this.gain.gain.value = volume;
    this.gain.connect(audioCtx().destination);
  }

  get duration(): number { return this.buffer.duration; }
  get playing(): boolean { return !!this.src && this.pausedAt === null; }
  set volume(v: number) { this.gain.gain.value = v; }

  /** Start playback at song position `from` after `delay` seconds. */
  play(from = 0, delay = 0.15): void {
    this.stopSource();
    const c = audioCtx();
    const src = c.createBufferSource();
    src.buffer = this.buffer;
    src.connect(this.gain);
    const when = c.currentTime + delay;
    // a negative `from` is a lead-in: the file starts -from seconds after `when`
    src.start(when + Math.max(0, -from), Math.max(0, from));
    // heardNow() reaches `when` exactly when the sample scheduled for `when` is heard
    this.startAt = when - from;
    src.onended = () => {
      if (this.src === src && this.pausedAt === null) {
        this.src = null;
        this.onEnded?.();
      }
    };
    this.src = src;
    this.pausedAt = null;
  }

  /** Current song position (heard). */
  time(): number {
    if (this.pausedAt !== null) return this.pausedAt;
    return heardNow() - this.startAt;
  }

  /** Audio-context time at which song position `pos` is heard (for scheduling extra sounds in sync). */
  clockAt(pos: number): number { return this.startAt + pos; }

  /** Song position at which a key event happened. */
  timeOf(e: { timeStamp: number }): number {
    if (this.pausedAt !== null) return this.pausedAt;
    return heardAt(e) - this.startAt;
  }

  pause(): void {
    if (this.pausedAt !== null || !this.src) return;
    this.pausedAt = this.time();
    this.stopSource();
  }

  resume(delay = 0.15): void {
    if (this.pausedAt === null) return;
    const at = this.pausedAt;
    this.play(at, delay);
  }

  stop(): void {
    this.stopSource();
    this.pausedAt = null;
  }

  dispose(): void {
    this.stop();
    this.gain.disconnect();
  }

  private stopSource(): void {
    if (this.src) {
      const s = this.src;
      this.src = null;
      s.onended = null;
      try { s.stop(); } catch { /* already stopped */ }
      s.disconnect();
    }
  }
}

/** Short click for metronomes / editor tick track. */
export function click(when: number, freq = 1500, gain = 0.5, dest?: AudioNode): void {
  const c = audioCtx();
  const o = c.createOscillator();
  const g = c.createGain();
  o.frequency.value = freq;
  g.gain.setValueAtTime(gain, when);
  g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
  o.connect(g).connect(dest ?? c.destination);
  o.start(when);
  o.stop(when + 0.06);
}
