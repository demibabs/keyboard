// The play screen's sky: a procedural night sky driven by the song (public/levels/<id>/viz.json, made by
// charting/analyze.py). Stars drift and twinkle, pulse on the beat; brighter "dancing" stars swirl through a
// flow field that speeds up with the music and link into constellations when the song is big; shooting
// stars on big hits; the whole sky shifts from the classic blue through purple to pink as the song builds.
// Without viz data it runs a calm default. Drawn on a canvas behind the lyrics; kept dim in the middle.

export interface Viz {
  fps: number;
  tempo: number;
  beats: [number, number][]; // [time, strength 0..1]
  hits: number[];
  energy: number[]; onset: number[]; bright: number[]; intensity: number[]; color: number[]; // 0..255
}

export async function loadViz(id: string): Promise<Viz | null> {
  try {
    const r = await fetch(`levels/${id}/viz.json`);
    if (!r.ok || !(r.headers.get("content-type") ?? "").includes("json")) return null;
    return await r.json();
  } catch { return null; }
}

type RGB = [number, number, number];
// sky top, sky bottom, nebula glow, star tint: classic blue -> purple -> pink
const BLUE = { top: [11, 18, 51], bot: [22, 20, 71], neb: [88, 112, 232], star: [222, 230, 255] } as const;
const PURPLE = { top: [19, 13, 56], bot: [42, 20, 92], neb: [150, 102, 236], star: [234, 220, 255] } as const;
const PINK = { top: [38, 10, 48], bot: [104, 22, 88], neb: [255, 118, 196], star: [255, 222, 238] } as const;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mixRGB = (a: readonly number[], b: readonly number[], t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const rgba = (c: RGB, a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
function palette(c: number) {
  const [from, to, t] = c < 0.5 ? [BLUE, PURPLE, c * 2] : [PURPLE, PINK, (c - 0.5) * 2];
  return { top: mixRGB(from.top, to.top, t), bot: mixRGB(from.bot, to.bot, t), neb: mixRGB(from.neb, to.neb, t), star: mixRGB(from.star, to.star, t) };
}
/** exponential approach: move `cur` towards `target` at `rate` per second */
const approach = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

function rng(seed: number) {
  return () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32);
}

interface Star { x: number; y: number; z: number; r: number; ph: number; sp: number }
interface Dancer { x: number; y: number; vx: number; vy: number; trail: number[]; seed: number; age: number; life: number }
interface Streak { x: number; y: number; vx: number; vy: number; life: number; max: number }
interface Spark { x: number; y: number; vx: number; vy: number; life: number }

const DPR_CAP = 1.5;

/** A soft white dot (drawn once, then stamped with drawImage + globalAlpha: much cheaper than gradients). */
function glowSprite(size: number, hard: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d")!;
  const rg = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  rg.addColorStop(0, "rgba(255,255,255,1)");
  rg.addColorStop(hard, "rgba(255,255,255,0.55)");
  rg.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = rg;
  g.fillRect(0, 0, size, size);
  return c;
}

export class Sky {
  private ctx: CanvasRenderingContext2D;
  private w = 0; private h = 0; private dpr = 1;
  private stars: Star[] = [];
  private dancers: Dancer[] = [];
  private streaks: Streak[] = [];
  private sparks: Spark[] = [];
  private rand = rng(11);
  // smoothed musical state
  private col = 0; private en = 0.3; private int = 0.3; private bright = 0.5;
  private pulse = 0; private kick = 0; private clock = 0;
  private beatIdx = 0; private hitIdx = 0; private lastT = -1e9; private lastKick = 0;
  private readonly calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  private onResize = () => this.resize();
  private dot = glowSprite(32, 0.18); // dancers
  private pin = glowSprite(8, 0.45); // background stars
  private tint = document.createElement("canvas"); // the sprites tinted to the current star colour
  private tintKey = "";
  // slow layers (sky gradient + glows behind the stars; ground + the dim middle in front), drawn small and
  // stretched: they only change gradually, so they're refreshed every few frames
  private back = document.createElement("canvas");
  private front = document.createElement("canvas");
  private layerAge = 99;

  constructor(private canvas: HTMLCanvasElement, private viz: Viz | null) {
    this.ctx = canvas.getContext("2d")!;
    const r = this.rand;
    for (let i = 0; i < 230; i++) this.stars.push({ x: r(), y: r() * 0.9, z: 0.25 + r() * 0.75, r: 0.5 + r() * 1.1, ph: r() * 6.28, sp: 0.6 + r() * 1.8 });
    // each dancer lives 8-18 s, then fades out and reappears somewhere else (the flow field has spots that
    // gather them, so without this they end up in a clump)
    for (let i = 0; i < 64; i++) this.dancers.push({ x: r(), y: r() * 0.85, vx: 0, vy: 0, trail: [], seed: r() * 100, age: r() * 12, life: 8 + r() * 10 });
    window.addEventListener("resize", this.onResize);
    this.resize();
  }

  dispose(): void { window.removeEventListener("resize", this.onResize); }

  private resize() {
    this.dpr = Math.min(DPR_CAP, window.devicePixelRatio || 1);
    this.w = this.canvas.clientWidth; this.h = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.w * this.dpr); this.canvas.height = Math.round(this.h * this.dpr);
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  private sample(arr: number[] | undefined, t: number, fallback: number): number {
    if (!arr || !arr.length || !this.viz) return fallback;
    const f = Math.max(0, t * this.viz.fps), i = Math.floor(f);
    if (i >= arr.length - 1) return arr[arr.length - 1] / 255;
    return lerp(arr[i], arr[i + 1], f - i) / 255;
  }

  /** Sparkles from a point on screen (CSS px), e.g. when a line is finished clean. */
  burst(x: number, y: number, n = 14): void {
    if (this.calm) return;
    for (let i = 0; i < n; i++) {
      const a = this.rand() * Math.PI * 2, s = 60 + this.rand() * 140;
      this.sparks.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 40, life: 0.7 + this.rand() * 0.5 });
    }
  }

  /** Advance to song time `t` (seconds into the audio at 1x) after `dt` real seconds, and draw. */
  frame(t: number, dt: number): void {
    dt = Math.min(dt, 0.1);
    this.clock += dt;
    const v = this.viz;
    // ---- musical state ----
    const jumped = Math.abs(t - this.lastT) > 1.5;
    if (jumped && v) { // seek (start, Tab skip): find our place in the beat and hit lists without firing them
      this.beatIdx = v.beats.findIndex((b) => b[0] > t); if (this.beatIdx < 0) this.beatIdx = v.beats.length;
      this.hitIdx = v.hits.findIndex((x) => x > t); if (this.hitIdx < 0) this.hitIdx = v.hits.length;
    }
    this.lastT = t;
    const live = t >= 0;
    const en = live ? this.sample(v?.energy, t, 0.35) : 0.15;
    const onset = live ? this.sample(v?.onset, t, 0.2) : 0;
    this.en = approach(this.en, en, 6, dt);
    this.int = approach(this.int, live ? this.sample(v?.intensity, t, 0.35) : 0.1, 1.2, dt);
    this.col = approach(this.col, live ? this.sample(v?.color, t, 0.15) : 0, 0.8, dt);
    this.bright = approach(this.bright, this.sample(v?.bright, t, 0.5), 2, dt);
    this.pulse *= Math.exp(-dt * 5);
    this.kick *= Math.exp(-dt * 3);
    if (v && live) {
      while (this.beatIdx < v.beats.length && v.beats[this.beatIdx][0] <= t) {
        this.pulse = Math.max(this.pulse, 0.35 + 0.65 * v.beats[this.beatIdx][1]);
        this.beatIdx++;
      }
      while (this.hitIdx < v.hits.length && v.hits[this.hitIdx] <= t) { this.shoot(); this.hitIdx++; }
      if (onset > 0.7 && this.clock - this.lastKick > 0.18) { this.kick = Math.min(1, this.kick + onset * 0.6); this.lastKick = this.clock; }
    } else if (!v && live) {
      this.pulse = Math.max(this.pulse, 0.25 * (0.5 + 0.5 * Math.sin(this.clock * 2)));
    }
    const motion = this.calm ? 0.15 : 1;
    const pal = palette(this.col);
    const { ctx, w, h } = this;

    // ---- sky + nebulae (slow layer) ----
    if (++this.layerAge >= 3) { this.layerAge = 0; this.paintLayers(pal); }
    ctx.globalCompositeOperation = "source-over";
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.back, 0, 0, w, h);

    // ---- stars: drift slowly, faster with the music; twinkle; pulse on the beat ----
    ctx.globalCompositeOperation = "lighter";
    const [dot, pin] = this.tinted(pal.star);
    const drift = (0.004 + 0.02 * this.en) * motion;
    for (const s of this.stars) {
      s.x -= dt * drift * s.z;
      if (s.x < -0.01) { s.x += 1.02; s.y = this.rand() * 0.9; }
      const tw = 0.5 + 0.5 * Math.sin(this.clock * s.sp + s.ph);
      ctx.globalAlpha = Math.min(1, (0.18 + 0.42 * s.z) * (0.55 + 0.45 * tw) + this.pulse * 0.45 * s.z);
      const r = 2.2 * s.r * (1 + this.pulse * 0.7 * s.z);
      ctx.drawImage(pin, s.x * w - r, s.y * h - r, 2 * r, 2 * r);
    }
    ctx.globalAlpha = 1;

    // ---- dancing stars: a flow field, faster and more of them as the song builds ----
    const visible = Math.round(16 + 48 * this.int);
    const speed = (0.012 + 0.07 * this.en + 0.05 * this.kick) * motion;
    const T = this.clock * (0.12 + 0.25 * this.en);
    const trailLen = Math.round(6 + 22 * this.en);
    const trails = [new Path2D(), new Path2D(), new Path2D()]; // tail .. head, drawn fainter .. stronger
    for (let i = 0; i < this.dancers.length; i++) {
      const d = this.dancers[i];
      const ang = (Math.sin(d.x * 3.1 + T + d.seed * 0.01) + Math.cos(d.y * 4.3 - T * 0.8) + Math.sin((d.x - d.y) * 2.2 + T * 1.3)) * 1.25;
      // on the beat, a little swirl around the middle of the sky
      const ox = d.x - 0.5, oy = d.y - 0.42;
      const swirl = this.pulse * 0.6;
      const tx = Math.cos(ang) * speed - oy * swirl * speed * 3;
      const ty = Math.sin(ang) * speed * 0.7 + ox * swirl * speed * 3;
      d.vx = approach(d.vx, tx, 2.5, dt); d.vy = approach(d.vy, ty, 2.5, dt);
      d.x += d.vx * dt; d.y += d.vy * dt * (w / h);
      let wrapped = false;
      if (d.x < -0.03) { d.x += 1.06; wrapped = true; } else if (d.x > 1.03) { d.x -= 1.06; wrapped = true; }
      if (d.y < -0.03) { d.y += 0.92; wrapped = true; } else if (d.y > 0.89) { d.y -= 0.92; wrapped = true; }
      d.age += dt;
      if (d.age > d.life) { // respawn somewhere random
        d.x = this.rand(); d.y = this.rand() * 0.85; d.vx = d.vy = 0; d.age = 0; d.life = 8 + this.rand() * 10;
        wrapped = true;
      }
      if (wrapped) d.trail.length = 0;
      d.trail.push(d.x * w, d.y * h);
      while (d.trail.length > trailLen * 2) d.trail.splice(0, 2);
      // fade in/out over their life, and as the visible count changes
      const vis = Math.max(0, Math.min(1, visible - i)) * Math.min(1, d.age / 1.2, (d.life - d.age) / 1.2);
      if (vis <= 0 || this.calm && i > 20) continue;
      // trail in three pieces, fainter towards the tail (added to the shared paths, stroked below)
      const tr = d.trail, pts = tr.length / 2;
      if (pts > 3 && vis > 0.5) for (let part = 0; part < 3; part++) {
        const from = Math.floor((pts - 1) * part / 3), to = Math.floor((pts - 1) * (part + 1) / 3);
        const p = trails[part];
        p.moveTo(tr[from * 2], tr[from * 2 + 1]);
        for (let k = from + 1; k <= to; k++) p.lineTo(tr[k * 2], tr[k * 2 + 1]);
      }
      ctx.globalAlpha = (0.55 + 0.45 * this.pulse) * vis;
      const r = 8 + 6 * this.pulse;
      ctx.drawImage(dot, d.x * w - r, d.y * h - r, 2 * r, 2 * r);
      ctx.globalAlpha = 1;
    }
    trails.forEach((p, part) => {
      ctx.strokeStyle = rgba(pal.star, 0.07 * (part + 1));
      ctx.lineWidth = 0.7 + 0.5 * part;
      ctx.stroke(p);
    });
    // constellations between nearby dancers when the song is big (three strengths by distance, one path each)
    if (this.int > 0.45) {
      const link = (this.int - 0.45) * 0.5;
      const maxD = Math.min(w, h) * 0.16;
      const bands = [new Path2D(), new Path2D(), new Path2D()]; // near, middle, far
      const n = Math.min(visible, this.dancers.length);
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const a = this.dancers[i], b = this.dancers[j];
        const dx = (a.x - b.x) * w, dy = (a.y - b.y) * h, d2 = dx * dx + dy * dy;
        if (d2 > maxD * maxD) continue;
        const p = bands[Math.min(2, Math.floor(Math.sqrt(d2) / maxD * 3))];
        p.moveTo(a.x * w, a.y * h); p.lineTo(b.x * w, b.y * h);
      }
      ctx.lineWidth = 0.8;
      bands.forEach((p, k) => { ctx.strokeStyle = rgba(pal.star, link * 0.5 * (1 - (k + 0.5) / 3)); ctx.stroke(p); });
    }

    // ---- shooting stars on big hits ----
    for (let i = this.streaks.length - 1; i >= 0; i--) {
      const s = this.streaks[i];
      s.life -= dt;
      if (s.life <= 0) { this.streaks.splice(i, 1); continue; }
      s.x += s.vx * dt; s.y += s.vy * dt;
      const f = s.life / s.max, len = 0.22;
      const x0 = s.x * w, y0 = s.y * h, x1 = (s.x - s.vx * len) * w, y1 = (s.y - s.vy * len) * h;
      const sg = ctx.createLinearGradient(x0, y0, x1, y1);
      sg.addColorStop(0, rgba([255, 250, 235], 0.9 * f));
      sg.addColorStop(1, rgba(pal.star, 0));
      ctx.strokeStyle = sg; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }

    // ---- sparkles (clean lines) ----
    for (let i = this.sparks.length - 1; i >= 0; i--) {
      const p = this.sparks[i];
      p.life -= dt;
      if (p.life <= 0) { this.sparks.splice(i, 1); continue; }
      p.vx *= Math.exp(-dt * 2.5); p.vy = p.vy * Math.exp(-dt * 2.5) + 60 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt;
      ctx.fillStyle = rgba([253, 227, 145], Math.min(1, p.life * 1.4));
      ctx.beginPath(); ctx.arc(p.x, p.y, 1.6, 0, 6.283); ctx.fill();
    }

    // ---- ground + the dim middle (slow layer), then the horizon line, like the landing page's ----
    ctx.globalCompositeOperation = "source-over";
    ctx.drawImage(this.front, 0, 0, w, h);
    const hy = h * 0.9;
    const hg = ctx.createLinearGradient(0, 0, w, 0);
    const ha = 0.35 + 0.35 * this.en + 0.25 * this.pulse;
    hg.addColorStop(0, rgba(pal.neb, 0)); hg.addColorStop(0.5, rgba(mixRGB(pal.neb, [255, 255, 255], 0.35), ha)); hg.addColorStop(1, rgba(pal.neb, 0));
    ctx.fillStyle = hg; ctx.fillRect(0, hy, w, 1.5);
  }

  /** Redraw the slow layers at half size (a quarter showed faint banding when stretched). */
  private paintLayers(pal: ReturnType<typeof palette>) {
    const W = Math.max(2, Math.round(this.w / 2)), H = Math.max(2, Math.round(this.h / 2));
    for (const c of [this.back, this.front]) if (c.width !== W || c.height !== H) { c.width = W; c.height = H; }
    let g = this.back.getContext("2d")!;
    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, rgba(pal.top, 1));
    sky.addColorStop(0.75, rgba(pal.bot, 1));
    sky.addColorStop(1, rgba(mixRGB(pal.bot, [8, 6, 22], 0.55), 1));
    g.fillStyle = sky; g.fillRect(0, 0, W, H);
    // nebulae: soft glows that grow with the song
    for (let i = 0; i < 3; i++) {
      const px = W * (0.2 + 0.6 * ((i * 0.37 + 0.5 + 0.08 * Math.sin(this.clock * 0.05 + i * 2)) % 1));
      const py = H * (0.25 + 0.3 * (0.5 + 0.5 * Math.sin(this.clock * 0.04 + i * 1.7)));
      const rad = Math.max(W, H) * (0.32 + 0.1 * i);
      const a = 0.04 + 0.13 * this.int + 0.05 * this.pulse;
      const ng = g.createRadialGradient(px, py, 0, px, py, rad);
      ng.addColorStop(0, rgba(pal.neb, a)); ng.addColorStop(1, rgba(pal.neb, 0));
      g.fillStyle = ng; g.fillRect(0, 0, W, H);
    }
    g = this.front.getContext("2d")!;
    g.clearRect(0, 0, W, H);
    const hy = H * 0.9;
    const gg = g.createLinearGradient(0, hy, 0, H);
    gg.addColorStop(0, rgba([8, 6, 24], 0.55)); gg.addColorStop(1, rgba([6, 5, 18], 0.9));
    g.fillStyle = gg; g.fillRect(0, hy, W, H - hy);
    // keep the lyrics readable: a soft dark band across the middle
    const vg = g.createRadialGradient(W / 2, H * 0.47, 0, W / 2, H * 0.47, Math.max(W * 0.5, H * 0.42));
    vg.addColorStop(0, rgba(pal.top, 0.55)); vg.addColorStop(0.55, rgba(pal.top, 0.3)); vg.addColorStop(1, rgba(pal.top, 0));
    g.fillStyle = vg; g.fillRect(0, 0, W, H);
  }

  /** The two sprites tinted to the current star colour (re-tinted only when the colour moves noticeably). */
  private tinted(c: RGB): [HTMLCanvasElement, HTMLCanvasElement] {
    const key = c.map((v) => Math.round(v / 6)).join();
    if (key !== this.tintKey) {
      this.tintKey = key;
      const t = this.tint;
      t.width = this.dot.width + this.pin.width; t.height = this.dot.height;
      const g = t.getContext("2d")!;
      g.clearRect(0, 0, t.width, t.height);
      g.drawImage(this.dot, 0, 0); g.drawImage(this.pin, this.dot.width, 0);
      g.globalCompositeOperation = "source-in";
      g.fillStyle = rgba(c, 1); g.fillRect(0, 0, t.width, t.height);
      g.globalCompositeOperation = "source-over";
      this.tintSprites = [this.cut(t, 0, this.dot.width, this.dot.height), this.cut(t, this.dot.width, this.pin.width, this.pin.height)];
    }
    return this.tintSprites!;
  }
  private tintSprites: [HTMLCanvasElement, HTMLCanvasElement] | null = null;
  private cut(src: HTMLCanvasElement, x: number, w: number, h: number): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    c.getContext("2d")!.drawImage(src, x, 0, w, h, 0, 0, w, h);
    return c;
  }

  private shoot() {
    if (this.calm || this.streaks.length > 2) return;
    const r = this.rand, left = r() < 0.5;
    this.streaks.push({ x: left ? 0.1 + r() * 0.3 : 0.6 + r() * 0.3, y: 0.05 + r() * 0.2, vx: (left ? 1 : -1) * (0.5 + r() * 0.3), vy: 0.25 + r() * 0.15, life: 0.9, max: 0.9 });
  }
}
