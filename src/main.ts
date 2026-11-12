import { audioCtx } from "./audio";
import { selectScreen } from "./select";

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

go(() => selectScreen());
