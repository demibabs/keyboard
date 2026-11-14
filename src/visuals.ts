// The play screen's sky: rows of dots gliding through the night along curving paths, over a gradient that
// shifts from the classic blue through purple to pink as the song builds. Driven by
// public/levels/<id>/viz.json (charting/analyze.py); without it, a calm default.
//  - each row has its own spacing, speed, direction and curve; spacing breathes and varies along the row
//  - louder = faster flow and deeper curves; on each beat the dots swell together; big hits make it surge
//  - finishing a line clean makes the dots near its end flare up
// Cheap by design: one WebGL draw call (every dot's position is worked out on the GPU), and the sky
// colours are CSS custom properties on the play screen, updated a few times a second.

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
// sky top, sky bottom, glow, dot colour: classic blue -> purple -> pink
const BLUE = { top: [11, 18, 51], bot: [22, 20, 71], neb: [88, 112, 232], dot: [214, 224, 255] } as const;
const PURPLE = { top: [19, 13, 56], bot: [42, 20, 92], neb: [150, 102, 236], dot: [230, 214, 255] } as const;
const PINK = { top: [38, 10, 48], bot: [104, 22, 88], neb: [255, 118, 196], dot: [255, 218, 236] } as const;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mixRGB = (a: readonly number[], b: readonly number[], t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const css = (c: RGB, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
function palette(c: number) {
  const [from, to, t] = c < 0.5 ? [BLUE, PURPLE, c * 2] : [PURPLE, PINK, (c - 0.5) * 2];
  return { top: mixRGB(from.top, to.top, t), bot: mixRGB(from.bot, to.bot, t), neb: mixRGB(from.neb, to.neb, t), dot: mixRGB(from.dot, to.dot, t) };
}
/** exponential approach: move `cur` towards `target` at `rate` per second */
const approach = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

const MAX_FLARES = 4;
const ROWS = 16;
const PER_ROW = 220; // dots allocated per row (enough for the widest screens at the tightest spacing)
const FLARE_LIFE = 1.4; // s

// The field: ROWS streams of dots, each gliding along its own curving wave. Every row has its own spacing,
// speed, direction, curve and size, so the whole thing reads as organised but not uniform; spacing also
// breathes over time and varies along each row, so dots bunch and spread as they travel.
const VERT = `
attribute float aRow, aIdx;
uniform vec2 uRes;                       // canvas size, CSS px
uniform float uTime, uWave, uPulse, uAmp, uBreath, uDpr;
uniform float uY[${ROWS}], uSpace[${ROWS}], uShift[${ROWS}], uCurve[${ROWS}], uLen[${ROWS}], uPh[${ROWS}], uSize[${ROWS}];
uniform vec4 uFlare[${MAX_FLARES}];      // x, y (CSS px), start time, strength
varying float vA; varying float vFlare;
void main() {
  int r = int(aRow + 0.5);
  float ph = uPh[r];
  // spacing: the row's own, breathing slowly
  float sp = uSpace[r] * (1.0 + uBreath * sin(uTime * (0.21 + 0.05 * ph) + ph * 3.0));
  float period = uRes.x + 160.0;
  float u0 = aIdx * sp;
  if (u0 > period) { gl_PointSize = 0.0; gl_Position = vec4(2.0, 2.0, 0.0, 1.0); vA = 0.0; vFlare = 0.0; return; }
  float u = mod(u0 + uShift[r], period) - 80.0;
  // spacing also varies along the row (monotonic warp), drifting as the dots travel
  float x = u + 34.0 * sin(u * 0.0045 + uWave * 0.6 + ph * 5.0);
  // the curve: two waves, deeper with the music
  float k = 6.2832 / uLen[r];
  float y = uY[r] * uRes.y
          + uCurve[r] * uAmp * (sin(x * k + uWave + ph * 7.0) + 0.45 * sin(x * k * 2.3 - uWave * 0.7 + ph * 11.0));
  // a soft swell of light travelling along each row
  float swell = 0.5 + 0.5 * sin(x * 0.006 - uWave * 1.7 + ph * 4.0);
  float flare = 0.0;
  for (int i = 0; i < ${MAX_FLARES}; i++) {
    vec4 f = uFlare[i];
    float age = uTime - f.z;
    if (f.w <= 0.0 || age < 0.0 || age > ${FLARE_LIFE.toFixed(1)}) continue;
    float d = distance(vec2(x, y), f.xy);
    flare += exp(-d * d / (2.0 * 90.0 * 90.0)) * f.w * (1.0 - age / ${FLARE_LIFE.toFixed(1)});
  }
  float size = uSize[r] * (1.0 + 0.45 * swell + 0.6 * uPulse + 0.8 * flare);
  float a = (0.2 + 0.4 * swell + 0.3 * uPulse + 0.7 * flare) * (0.55 + 0.45 * uSize[r] / 3.0);
  // quieter behind the lyrics and below the horizon
  vec2 c = (vec2(x, y) / uRes - vec2(0.5, 0.47)) * vec2(1.0, 1.7);
  a *= mix(0.28, 1.0, smoothstep(0.1, 0.42, length(c)));
  a *= 1.0 - 0.8 * smoothstep(0.86, 0.91, y / uRes.y);
  vA = clamp(a, 0.0, 1.0);
  vFlare = clamp(flare, 0.0, 1.0);
  vec2 clip = vec2(x, y) / uRes * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  gl_PointSize = size * uDpr;
}`;
const FRAG = `
precision mediump float;
uniform vec3 uCol, uGlow;
varying float vA; varying float vFlare;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float m = smoothstep(0.5, 0.26, d) * vA;
  gl_FragColor = vec4(mix(uCol, uGlow, vFlare) * m, m); // premultiplied
}`;

function rng(seed: number) {
  return () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32);
}

/** The rows: fixed per session (seeded), so the "choreography" is consistent. */
function makeRows() {
  const r = rng(29);
  const spacings = [11, 14, 17, 21, 26, 32, 40, 50];
  const rows = [];
  for (let i = 0; i < ROWS; i++) {
    rows.push({
      y: 0.05 + 0.82 * (i + 0.2 + 0.6 * r()) / ROWS,          // spread down the sky, a little irregular
      space: spacings[Math.floor(r() * spacings.length)],
      speed: (14 + r() * 34) * (r() < 0.3 ? -1 : 1),         // px/s at rest; most flow one way, some the other
      curve: 14 + r() * 46,                                  // px
      len: 520 + r() * 900,                                  // wavelength, px
      ph: r() * 10,
      size: 1.4 + r() * 1.6,                                 // px
    });
  }
  return rows;
}

export class Sky {
  private gl: WebGLRenderingContext | null;
  private prog: WebGLProgram | null = null;
  private buf: WebGLBuffer | null = null;
  private count = 0;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private w = 0; private h = 0; private dpr = 1;
  private rows = makeRows();
  private shift = new Float32Array(ROWS); // how far each row has travelled (px)
  private wave = 0; // phase of the curves' motion
  private flares: number[] = new Array(MAX_FLARES * 4).fill(0);
  private nextFlare = 0;
  // smoothed musical state
  private col = 0; private en = 0.3; private int = 0.3;
  private pulse = 0; private surge = 0; private clock = 0; private cssAge = 99;
  private beatIdx = 0; private hitIdx = 0; private lastT = -1e9;
  private readonly calm = matchMedia("(prefers-reduced-motion: reduce)").matches;
  private onResize = () => this.resize();

  constructor(private canvas: HTMLCanvasElement, private host: HTMLElement, private viz: Viz | null) {
    this.gl = canvas.getContext("webgl", { premultipliedAlpha: true, antialias: false, alpha: true });
    if (this.gl) this.setup(this.gl);
    // start the rows at different points so the first frame doesn't look lined up
    this.rows.forEach((r, i) => (this.shift[i] = r.ph * 137));
    window.addEventListener("resize", this.onResize);
    this.resize();
  }

  dispose(): void { window.removeEventListener("resize", this.onResize); }

  private setup(gl: WebGLRenderingContext) {
    const shader = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? "shader");
      return sh;
    };
    try {
      const p = gl.createProgram()!;
      gl.attachShader(p, shader(gl.VERTEX_SHADER, VERT));
      gl.attachShader(p, shader(gl.FRAGMENT_SHADER, FRAG));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "link");
      this.prog = p;
    } catch (e) {
      console.warn("sky: WebGL unavailable, colours only", e);
      this.gl = null;
      return;
    }
    for (const n of ["uRes", "uTime", "uWave", "uPulse", "uAmp", "uBreath", "uDpr", "uY", "uSpace", "uShift", "uCurve", "uLen", "uPh", "uSize", "uFlare", "uCol", "uGlow"]) {
      this.u[n] = gl.getUniformLocation(this.p, n === "uY" || n === "uSpace" || n === "uShift" || n === "uCurve" || n === "uLen" || n === "uPh" || n === "uSize" || n === "uFlare" ? n + "[0]" : n);
    }
    // one vertex per dot: (row, index in row); positions are worked out in the shader
    const data = new Float32Array(ROWS * PER_ROW * 2);
    for (let r = 0, k = 0; r < ROWS; r++) for (let i = 0; i < PER_ROW; i++) { data[k++] = r; data[k++] = i; }
    this.count = ROWS * PER_ROW;
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.useProgram(this.p);
    const rows = this.rows;
    gl.uniform1fv(this.u.uY, rows.map((r) => r.y));
    gl.uniform1fv(this.u.uSpace, rows.map((r) => r.space));
    gl.uniform1fv(this.u.uCurve, rows.map((r) => r.curve));
    gl.uniform1fv(this.u.uLen, rows.map((r) => r.len));
    gl.uniform1fv(this.u.uPh, rows.map((r) => r.ph));
    gl.uniform1fv(this.u.uSize, rows.map((r) => r.size));
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }
  private get p(): WebGLProgram { return this.prog!; }

  private resize() {
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.w = this.canvas.clientWidth; this.h = this.canvas.clientHeight;
    this.canvas.width = Math.round(this.w * this.dpr); this.canvas.height = Math.round(this.h * this.dpr);
    this.gl?.viewport(0, 0, this.canvas.width, this.canvas.height);
  }

  private sample(arr: number[] | undefined, t: number, fallback: number): number {
    if (!arr || !arr.length || !this.viz) return fallback;
    const f = Math.max(0, t * this.viz.fps), i = Math.floor(f);
    if (i >= arr.length - 1) return arr[arr.length - 1] / 255;
    return lerp(arr[i], arr[i + 1], f - i) / 255;
  }

  /** Dots near a point on screen (CSS px) flare up, e.g. at the end of a line finished clean. */
  burst(x: number, y: number): void {
    if (this.calm) return;
    const r = this.canvas.getBoundingClientRect();
    const k = this.nextFlare++ % MAX_FLARES;
    this.flares.splice(k * 4, 4, x - r.left, y - r.top, this.clock, 1);
  }

  /** Advance to song time `t` (seconds into the audio at 1x) after `dt` real seconds, and draw. */
  frame(t: number, dt: number): void {
    dt = Math.min(dt, 0.1);
    this.clock += dt;
    const v = this.viz;
    if (Math.abs(t - this.lastT) > 1.5 && v) { // seek: find our place in the beats/hits without firing them
      this.beatIdx = v.beats.findIndex((b) => b[0] > t); if (this.beatIdx < 0) this.beatIdx = v.beats.length;
      this.hitIdx = v.hits.findIndex((x) => x > t); if (this.hitIdx < 0) this.hitIdx = v.hits.length;
    }
    this.lastT = t;
    const live = t >= 0;
    this.en = approach(this.en, live ? this.sample(v?.energy, t, 0.3) : 0.12, 4, dt);
    this.int = approach(this.int, live ? this.sample(v?.intensity, t, 0.3) : 0.1, 1.2, dt);
    this.col = approach(this.col, live ? this.sample(v?.color, t, 0.12) : 0, 0.8, dt);
    this.pulse *= Math.exp(-dt * 5);
    this.surge *= Math.exp(-dt * 1.2);
    if (v && live) {
      while (this.beatIdx < v.beats.length && v.beats[this.beatIdx][0] <= t) {
        this.pulse = Math.max(this.pulse, 0.25 + 0.75 * v.beats[this.beatIdx][1]);
        this.beatIdx++;
      }
      while (this.hitIdx < v.hits.length && v.hits[this.hitIdx] <= t) { this.surge = 1; this.hitIdx++; }
    } else if (live) { // no music data: a slow breath
      this.pulse = Math.max(this.pulse, 0.18 * (0.5 + 0.5 * Math.sin(this.clock * 1.6)));
    }
    // the performance: rows glide faster and curve deeper as the song gets louder and builds
    const motion = this.calm ? 0.15 : 1;
    const pace = (0.45 + 1.7 * this.en + 0.8 * this.surge) * motion;
    this.rows.forEach((r, i) => { this.shift[i] += r.speed * pace * dt; });
    this.wave += dt * (0.25 + 0.6 * this.en + 0.4 * this.surge) * motion;
    const amp = 0.5 + 0.9 * this.int + 0.6 * this.surge;
    const breath = 0.1 + 0.22 * this.int;
    const pal = palette(this.col);

    // sky colours: CSS on the play screen, a few times a second (they change slowly)
    if (++this.cssAge >= 6) {
      this.cssAge = 0;
      const st = this.host.style;
      st.setProperty("--sky-top", css(pal.top));
      st.setProperty("--sky-bot", css(pal.bot));
      st.setProperty("--sky-glow", css(pal.neb, 0.06 + 0.16 * this.int));
      st.setProperty("--sky-line", css(mixRGB(pal.neb, [255, 255, 255], 0.35), 0.55));
    }

    const gl = this.gl;
    if (!gl || !this.prog) return;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const aRow = gl.getAttribLocation(this.p, "aRow"), aIdx = gl.getAttribLocation(this.p, "aIdx");
    gl.enableVertexAttribArray(aRow); gl.vertexAttribPointer(aRow, 1, gl.FLOAT, false, 8, 0);
    gl.enableVertexAttribArray(aIdx); gl.vertexAttribPointer(aIdx, 1, gl.FLOAT, false, 8, 4);
    const u = this.u;
    gl.uniform2f(u.uRes, this.w, this.h);
    gl.uniform1f(u.uTime, this.clock);
    gl.uniform1f(u.uWave, this.wave);
    gl.uniform1f(u.uPulse, this.pulse);
    gl.uniform1f(u.uAmp, amp);
    gl.uniform1f(u.uBreath, breath);
    gl.uniform1f(u.uDpr, this.dpr);
    gl.uniform1fv(u.uShift, this.shift);
    gl.uniform4fv(u.uFlare, this.flares);
    gl.uniform3f(u.uCol, pal.dot[0] / 255, pal.dot[1] / 255, pal.dot[2] / 255);
    const glow = mixRGB(pal.neb, [255, 255, 255], 0.3);
    gl.uniform3f(u.uGlow, glow[0] / 255, glow[1] / 255, glow[2] / 255);
    gl.drawArrays(gl.POINTS, 0, this.count);
  }
}
