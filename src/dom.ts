// Tiny DOM helpers.
type Attrs = Record<string, string | number | boolean | ((e: any) => void) | undefined>;
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...kids: (Node | string | null | undefined | false)[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = String(v);
    else if (k === "text") el.textContent = String(v);
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
  return el;
}
export function fmtScore(n: number): string { return Math.round(n).toLocaleString("en-US"); }
export function pct(x: number, digits = 1): string { return (x * 100).toFixed(digits) + "%"; }
export function fmtTime(s: number): string {
  s = Math.max(0, s);
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}
export function tier(wpm: number): { name: string; cls: string } {
  if (wpm < 45) return { name: "Easy", cls: "t-easy" };
  if (wpm < 70) return { name: "Normal", cls: "t-normal" };
  if (wpm < 100) return { name: "Hard", cls: "t-hard" };
  if (wpm < 140) return { name: "Expert", cls: "t-expert" };
  return { name: "Insane", cls: "t-insane" };
}
