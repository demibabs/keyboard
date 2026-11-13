// Songs played through YouTube's embedded player (IFrame API). YouTube's embed rules: the player stays
// visible (at least 200x200) and the audio isn't separated from it, ads play normally, and nothing is
// downloaded. The game's clock is the video position: getCurrentTime() only updates every few hundred ms,
// so time runs on performance.now() and is nudged towards each fresh report.
import type { GamePlayer } from "./audio";
import type { YouTubeRef } from "./lyrics";

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window { YT?: any; onYouTubeIframeAPIReady?: () => void }
}

const PLAYING = 1, ENDED = 0, PAUSED = 2, BUFFERING = 3;
const HARD_RESYNC = 0.25; // jump straight to the reported position when this far off (s)
const SMOOTH = 0.15; // otherwise move this share of the way per report

export class Cancelled extends Error {}

let api: Promise<any> | null = null;
function loadApi(): Promise<any> {
  if (!api) {
    api = new Promise((resolve, reject) => {
      if (window.YT?.Player) return resolve(window.YT);
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(window.YT); };
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      s.onerror = () => { api = null; reject(new Error("Couldn't load the YouTube player. Check your connection.")); };
      document.head.append(s);
    });
  }
  return api;
}

// One player for the whole session, in a box outside the screens (screens are swapped on navigation).
let host: HTMLElement | null = null;
let caption: HTMLElement | null = null;
let yt: any = null;
let listener: ((state: number) => void) | null = null;
let errorListener: ((code: number) => void) | null = null;

function setMode(mode: "off" | "prep" | "corner", text = "") {
  if (!host) return;
  host.className = `yt-host ${mode}`;
  if (caption) caption.textContent = text;
}

async function ensurePlayer(videoId: string): Promise<any> {
  const YT = await loadApi();
  if (yt) return yt;
  host = document.createElement("div");
  const box = document.createElement("div");
  box.className = "yt-box";
  const slot = document.createElement("div");
  box.append(slot);
  caption = document.createElement("p");
  caption.className = "yt-caption";
  host.append(box, caption);
  document.body.append(host);
  setMode("prep", "Loading the video…");
  return new Promise((resolve, reject) => {
    const p = new YT.Player(slot, {
      videoId,
      host: "https://www.youtube-nocookie.com",
      playerVars: { controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, playsinline: 1, rel: 0 },
      events: {
        onReady: () => { yt = p; resolve(p); },
        onStateChange: (e: any) => listener?.(e.data),
        onError: (e: any) => { errorListener?.(e.data); if (!yt) reject(new Error(errorText(e.data))); },
      },
    });
  });
}

function errorText(code: number): string {
  if (code === 101 || code === 150) return "The video's owner doesn't allow it to be played in other sites.";
  if (code === 100) return "The video was removed or made private.";
  if (code === 2) return "The video id is invalid.";
  return `YouTube couldn't play the video (error ${code}).`;
}

/** Start the video muted and wait until the song itself is playing (ads first, if YouTube shows one), then
 * park it at `startSec` (video time). Rejects with Cancelled if Escape is pressed. */
async function prepare(ref: YouTubeRef, startSec: number, rate: number, volume: number): Promise<void> {
  const p = await ensurePlayer(ref.id);
  setMode("prep", "Starting the video… If YouTube plays an ad first, the song starts after it.  Esc to go back");
  const cur = p.getVideoData?.()?.video_id;
  p.mute();
  if (cur !== ref.id) p.loadVideoById({ videoId: ref.id, startSeconds: Math.max(0, startSec) });
  else { p.seekTo(Math.max(0, startSec), true); p.playVideo(); }
  await new Promise<void>((resolve, reject) => {
    const started = performance.now();
    const isSong = () => {
      if (p.getPlayerState() !== PLAYING || p.getVideoData?.()?.video_id !== ref.id) return false;
      const d = p.getDuration();
      return !ref.duration || Math.abs(d - ref.duration) < 4; // an ad has its own length
    };
    const timer = setInterval(() => {
      if (isSong()) return finish();
      if (performance.now() - started > 8000 && p.getPlayerState() !== PLAYING) {
        setMode("prep", "Waiting for the song… If an ad is playing, it starts right after. If nothing's playing, click the video.  Esc to go back");
      }
    }, 100);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); e.stopPropagation();
      cleanup(); stopVideo(); reject(new Cancelled());
    };
    errorListener = (code) => { cleanup(); stopVideo(); reject(new Error(errorText(code))); };
    function cleanup() {
      clearInterval(timer);
      window.removeEventListener("keydown", onKey, true);
      errorListener = null;
    }
    function finish() {
      cleanup();
      p.pauseVideo();
      p.seekTo(Math.max(0, startSec), true);
      p.setPlaybackRate(rate);
      p.setVolume(Math.round(volume * 100));
      p.unMute();
      resolve();
    }
    window.addEventListener("keydown", onKey, true);
  });
  setMode("corner");
}

function stopVideo() {
  try { yt?.pauseVideo(); } catch { /* not ready */ }
  setMode("off");
}

/** The video as the game's song player. Positions are real seconds: (video time - offset) / speed. */
export class YouTubePlayer implements GamePlayer {
  onEnded: (() => void) | null = null;
  private mode: "stopped" | "lead" | "starting" | "running" | "paused" = "stopped";
  private frozen = 0; // position while not running
  private base = 0; // position at `at` while running / in the lead-in
  private at = 0; // performance.now() ms
  private leadUntil = 0;
  private lastReport = NaN;

  private constructor(private readonly p: any, private readonly off: number, private readonly speed: number,
    readonly duration: number) {
    listener = (s) => this.onState(s);
  }

  /** Get the video ready (waits through any ad). `from` is the first position play() will be called with. */
  static async open(ref: YouTubeRef, speed: number, duration: number, volume: number, from: number): Promise<YouTubePlayer> {
    const off = ref.offsetMs / 1000;
    await prepare(ref, from * speed + off, speed, volume);
    return new YouTubePlayer(yt, off, speed, duration);
  }

  get playing(): boolean { return this.mode === "lead" || this.mode === "starting" || this.mode === "running"; }
  private video(pos: number) { return pos * this.speed + this.off; }
  private pos(video: number) { return (video - this.off) / this.speed; }

  play(from = 0, delay = 0): void {
    const start = this.pos(0); // where the video begins
    if (from < start) {
      // lead-in before the video's first frame: run the clock, start the video when it gets there
      this.p.pauseVideo();
      this.p.seekTo(0, true);
      this.mode = "lead";
      this.base = from;
      this.at = performance.now() + delay * 1000;
      this.leadUntil = start;
      return;
    }
    this.startVideo(from);
  }

  private startVideo(from: number) {
    this.mode = "starting";
    this.frozen = from;
    this.lastReport = NaN;
    this.p.seekTo(this.video(from), true);
    this.p.playVideo();
  }

  private onState(s: number) {
    if (s === PLAYING && this.mode === "starting") {
      this.mode = "running";
      this.base = this.frozen;
      this.at = performance.now();
    } else if ((s === BUFFERING || s === PAUSED) && this.mode === "running") {
      this.frozen = this.time(); // stalled or paused from the video itself: hold the clock until it plays again
      this.mode = "starting";
      if (s === PAUSED) this.p.playVideo();
    } else if (s === ENDED && this.playing) {
      this.frozen = this.time();
      this.mode = "stopped";
      this.onEnded?.();
    }
  }

  time(): number {
    const now = performance.now();
    if (this.mode === "lead") {
      const t = this.base + Math.max(0, now - this.at) / 1000;
      if (t < this.leadUntil) return t;
      this.startVideo(this.leadUntil);
      return this.leadUntil;
    }
    if (this.mode !== "running") return this.frozen;
    const t = this.base + (now - this.at) / 1000;
    const v = this.p.getCurrentTime();
    if (v !== this.lastReport) {
      this.lastReport = v;
      const err = this.pos(v) - t;
      if (Math.abs(err) > HARD_RESYNC) { this.base = this.pos(v); this.at = now; return this.base; }
      this.base += err * SMOOTH;
      return t + err * SMOOTH;
    }
    return t;
  }

  timeOf(e: { timeStamp: number }): number {
    if (this.mode !== "running" && this.mode !== "lead") return this.time();
    return this.time() - Math.max(0, performance.now() - e.timeStamp) / 1000;
  }

  pause(): void {
    if (!this.playing) return;
    this.frozen = this.time();
    this.mode = "paused";
    this.p.pauseVideo();
  }

  resume(): void {
    if (this.mode !== "paused") return;
    this.play(this.frozen);
  }

  stop(): void {
    this.frozen = this.mode === "stopped" ? this.frozen : this.time();
    this.mode = "stopped";
    try { this.p.pauseVideo(); } catch { /* gone */ }
  }

  dispose(): void {
    this.stop();
    if (listener) listener = null;
    setMode("off");
  }
}
