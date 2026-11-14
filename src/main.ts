import { audioCtx } from "./audio";
import { landingScreen, notFoundScreen } from "./landing";
import { songMenuScreen } from "./menu/song-menu";

export interface Screen {
  el: HTMLElement;
  onKey?(e: KeyboardEvent): void;
  destroy?(): void;
}

const root = document.getElementById("app")!;
let current: Screen | null = null;
let token = 0;

export async function go(make: () => Screen | Promise<Screen>): Promise<void> {
  const my = ++token;
  current?.destroy?.();
  current = null;
  root.replaceChildren(loading());
  try {
    const s = await make();
    if (my !== token) { s.destroy?.(); return; }
    current = s;
    root.replaceChildren(s.el);
  } catch (err) {
    console.error(err);
    if (my !== token) return;
    const msg = document.createElement("div");
    msg.className = "fatal";
    msg.textContent = String(err);
    root.replaceChildren(msg);
  }
}

function loading(): HTMLElement {
  const d = document.createElement("div");
  d.className = "loading";
  d.textContent = "loading…";
  return d;
}

window.addEventListener("keydown", (e) => {
  // browsers only start audio after a user gesture
  if (audioCtx().state === "suspended") void audioCtx().resume();
  current?.onKey?.(e);
}, { capture: true });
window.addEventListener("pointerdown", () => {
  if (audioCtx().state === "suspended") void audioCtx().resume();
});

// Pages are addressed by the hash (#/, #/play, ...), which works on any static host. The game's own screens
// (play, results, editor) live under #/play without addresses of their own.
const PAGES: Record<string, () => Screen | Promise<Screen>> = { "": landingScreen, play: songMenuScreen };
const page = () => location.hash.replace(/^#\/?/, "").replace(/\/$/, "");
function route() { go(PAGES[page()] ?? notFoundScreen); }
/** Go to a page (e.g. "play", "" for home), as a link would. */
export function navigate(to: string): void {
  if (page() === to) route();
  else location.hash = `#/${to}`;
}
window.addEventListener("hashchange", route);
route();
