// Landing page hero: the wordmark, tagline and Play button, with lyric cards on the sides that type out
// a line of a featured song the way the game does. Lyric text is fetched from LRCLIB at runtime (like the
// game), so none is stored here: each card types the song's most repeated line (usually the hook).
import "./landing.css";
import { flatten, typedOf, type Chart } from "./chart";
import { h } from "./dom";
import { go, type Screen } from "./main";
import { loadLevel, loadLyrics } from "./lyrics";
import { selectScreen } from "./select";

interface Featured {
  id: string; title: string; artist: string; album: string; art: string;
  tint: string; // card colour, as "r, g, b"
  tilt: number; // degrees
  size: number; // scale of the card (width and text)
  slips: number; // share of lines typed with a mistake or an autocorrection
}
const ART = "https://is1-ssl.mzstatic.com/image/thumb/";
const FEATURED: Featured[] = [
  { id: "coldplay-yellow", title: "Yellow", artist: "Coldplay", album: "Parachutes",
    art: ART + "Music221/v4/f5/93/8c/f5938c49-964c-31d1-4b33-78b634f71fb7/190295978075.jpg/160x160bb.jpg",
    tint: "253, 200, 120", tilt: -3.5, size: 1.08, slips: 0.25 },
  { id: "oasis-wonderwall", title: "Wonderwall", artist: "Oasis", album: "(What's the Story) Morning Glory?",
    art: ART + "Music113/v4/04/92/e0/0492e08b-cbcc-9969-9ad6-8f5a0888068c/5051961007107.jpg/160x160bb.jpg",
    tint: "120, 205, 255", tilt: 2.5, size: 0.9, slips: 0.6 },
  { id: "billie-eilish-birds-of-a-feather", title: "Birds of a Feather", artist: "Billie Eilish", album: "Hit Me Hard and Soft",
    art: ART + "Music211/v4/92/9f/69/929f69f1-9977-3a44-d674-11f70c852d1b/24UMGIM36186.rgb.jpg/160x160bb.jpg",
    tint: "214, 150, 255", tilt: 4, size: 1, slips: 0.6 },
];

const SVG = "http://www.w3.org/2000/svg";
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The song's hook (most repeated line of a comfortable length) and the line after it. */
export function hookLines(chart: Chart): string[] {
  const lines = flatten(chart).lines.map((l) => ({ text: l.text, n: l.end - l.first, key: typedOf(l.text.replace(/\([^)]*\)/g, "")) }));
  const ok = (l: { n: number }) => l.n >= 14 && l.n <= 44;
  const count = new Map<string, number>();
  for (const l of lines) if (ok(l)) count.set(l.key, (count.get(l.key) ?? 0) + 1);
  let best = -1;
  lines.forEach((l, i) => { if (ok(l) && (best < 0 || count.get(l.key)! > count.get(lines[best].key)!)) best = i; });
  if (best < 0) return [];
  const next = lines.slice(best + 1).find((l) => l.key !== lines[best].key && l.n <= 48);
  return next ? [lines[best].text, next.text] : [lines[best].text];
}

// ---------- background: stars and faint constellations (seeded, so it's the same every visit) ----------
function rng(seed: number) {
  return () => ((seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 2 ** 32);
}
function sky(): SVGSVGElement {
  const r = rng(7);
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 1600 1000");
  svg.setAttribute("preserveAspectRatio", "xMidYMid slice");
  svg.setAttribute("class", "sky");
  svg.setAttribute("aria-hidden", "true");
  const el = (tag: string, attrs: Record<string, string | number>) => {
    const e = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    return svg.appendChild(e);
  };
  for (let i = 0; i < 150; i++) {
    const s = el("circle", { cx: r() * 1600, cy: r() * 820, r: 0.5 + r() * 1.1, class: "star" });
    s.style.opacity = String(0.2 + r() * 0.6);
    if (r() < 0.18) { s.classList.add("twinkle"); s.style.animationDelay = `${-r() * 6}s`; }
  }
  // constellations around the edges, away from the wordmark
  const areas = [[90, 80, 330, 240], [1180, 60, 360, 230], [60, 520, 300, 230], [1240, 470, 300, 260], [560, 40, 260, 120], [980, 700, 280, 110]];
  for (const [x, y, w, hh] of areas) {
    const n = 4 + Math.floor(r() * 3);
    const pts: [number, number][] = [];
    let px = x + r() * w * 0.3, py = y + r() * hh;
    for (let i = 0; i < n; i++) {
      pts.push([px, py]);
      px = Math.min(x + w, px + 40 + r() * (w / n));
      py = Math.max(y, Math.min(y + hh, py + (r() - 0.5) * hh * 0.7));
    }
    el("polyline", { points: pts.map((p) => p.join(",")).join(" "), class: "constellation" });
    if (n > 4) { const a = pts[1], b = [a[0] + (r() - 0.3) * 80, a[1] + 50 + r() * 60]; el("line", { x1: a[0], y1: a[1], x2: b[0], y2: b[1], class: "constellation" }); el("circle", { cx: b[0], cy: b[1], r: 1.7, class: "node" }); }
    for (const [cx, cy] of pts) el("circle", { cx, cy, r: 1.7, class: "node" });
  }
  return svg;
}

function sparkle(cls: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", cls);
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS(SVG, "path");
  p.setAttribute("d", "M12 0C12.9 7.2 16.8 11.1 24 12 16.8 12.9 12.9 16.8 12 24 11.1 16.8 7.2 12.9 0 12 7.2 11.1 11.1 7.2 12 0Z");
  svg.append(p);
  return svg;
}

// ---------- lyric cards ----------
function card(f: Featured, alive: () => boolean): HTMLElement {
  const line = h("div", { class: "lc-line loading" }, h("span", { class: "lc-skeleton" }));
  const fill = h("div", { class: "lc-timer-fill" });
  const el = h("article", { class: "lyric-card", "aria-label": `${f.title} by ${f.artist}` },
    h("img", { class: "lc-art", src: f.art, alt: `${f.album} cover`, width: 48, height: 48, loading: "lazy" }),
    line,
    h("div", { class: "lc-foot" }, h("div", { class: "lc-timer" }, fill)));

  async function run(texts: string[]) {
    line.classList.remove("loading");
    for (let k = 0; alive(); k = (k + 1) % texts.length) {
      const text = texts[k];
      const chars = [...text].map((c, i) => ({ c, span: h("span", { class: "lc-ch" }, c === " " ? " " : c), paren: false, i }));
      let depth = 0;
      for (const ch of chars) {
        if (ch.c === "(") depth++;
        ch.paren = depth > 0;
        if (ch.c === ")" && depth) depth--;
        if (ch.paren) ch.span.classList.add("paren");
      }
      // words stay together so a line only wraps between words (as in the game)
      line.replaceChildren();
      let word: HTMLElement | null = null;
      for (const ch of chars) {
        if (ch.c === " ") { word = null; line.append(ch.span); continue; }
        if (!word) line.append((word = h("span", { class: "lc-word" })));
        word.append(ch.span);
      }
      el.classList.remove("done", "out");
      const typeable = chars.filter((ch) => !ch.paren);
      if (reduceMotion()) {
        typeable.forEach((ch) => ch.span.classList.add("ok"));
        el.classList.add("done");
        return;
      }
      // the line's window: a bit longer than the typing takes, drained by the timer bar
      const delays = typeable.map((ch) => (ch.c === " " ? 95 + Math.random() * 60 : /[a-z0-9]/i.test(ch.c) ? 55 + Math.random() * 65 : 0));
      const total = delays.reduce((a, b) => a + b, 0) + 900;
      fill.style.transition = "none";
      fill.style.transform = "scaleX(1)";
      void fill.offsetWidth;
      await sleep(500);
      fill.style.transition = `transform ${total}ms linear`;
      fill.style.transform = "scaleX(0)";
      // some lines get a slip, shown the way the game shows it: a wrong letter (red), or a skipped letter
      // that the autocorrection caught, with the letters after it accepted as autocorrected (lavender)
      const result = typeable.map(() => "ok");
      const letters = typeable.map((ch, i) => (/[a-z0-9]/i.test(ch.c) ? i : -1)).filter((i) => i > 2);
      if (letters.length > 8 && Math.random() < f.slips) {
        const at = letters[Math.floor(Math.random() * (letters.length - 6))];
        result[at] = "typo";
        if (Math.random() < 0.5) for (let j = at + 1, n = 0; j < typeable.length && n < 4; j++, n++) {
          if (typeable[j].c === " ") break;
          result[j] = "fixed";
        }
      }
      for (let i = 0; i < typeable.length && alive(); i++) {
        typeable[i].span.classList.add("cursor");
        await sleep(delays[i]);
        typeable[i].span.classList.remove("cursor");
        typeable[i].span.classList.add(result[i]);
      }
      const left = getComputedStyle(fill).transform;
      fill.style.transition = "none";
      fill.style.transform = left === "none" ? "scaleX(0)" : left; // stop the bar where the line was finished
      el.classList.add("done");
      await sleep(2200);
      el.classList.add("out");
      await sleep(450);
    }
  }
  return Object.assign(el, { run });
}

export function landingScreen(): Screen {
  let alive = true;
  const isAlive = () => alive;
  const cards = FEATURED.map((f) => {
    const c = card(f, isAlive);
    c.style.setProperty("--tint", f.tint);
    c.style.setProperty("--tilt", `${f.tilt}deg`);
    c.style.setProperty("--size", String(f.size));
    return c;
  });
  // the wordmark is all there from the start, dim; it's "typed" by lighting up letter by letter
  const name = "startype";
  const letters = [...name].map((c) => h("span", { class: "wm-ch" }, c));
  const word = h("span", { class: "wm-text" }, ...letters);
  const play = () => go(() => selectScreen());

  const el = h("div", { class: "landing" },
    sky(),
    h("div", { class: "horizon", "aria-hidden": "true" }),
    h("section", { class: "hero" },
      h("div", { class: "hero-side left" }, cards[0], cards[1]),
      h("div", { class: "hero-center" },
        h("h1", { class: "wordmark", "aria-label": name }, word, h("span", { class: "wm-caret" }), sparkle("wm-star")),
        h("p", { class: "tagline" }, "Type along to your favorite songs"),
        h("button", { class: "hero-play", onclick: play },
          h("span", { class: "hero-play-icon", "aria-hidden": "true" }), "Play"),
        h("p", { class: "hero-hint" }, "or press ", h("kbd", {}, "Enter"))),
      h("div", { class: "hero-side right" }, cards[2])),
  );

  const wordmark = word.parentElement!;
  if (reduceMotion()) { letters.forEach((l) => l.classList.add("lit")); wordmark.classList.add("typed"); }
  else (async () => {
    // start once the font is in and the page is on screen, or it may finish before anyone sees it
    await document.fonts.ready;
    await new Promise(requestAnimationFrame);
    await sleep(350);
    for (const l of letters) {
      if (!alive) return;
      l.classList.add("cur");
      await sleep(95);
      l.classList.remove("cur");
      l.classList.add("lit");
    }
    wordmark.classList.add("typed");
  })();

  // cards: fetch each song's lyrics, then loop its lines (staggered); drop a card if LRCLIB can't be reached
  FEATURED.forEach(async (f, i) => {
    const c = cards[i] as HTMLElement & { run(t: string[]): Promise<void> };
    try {
      const texts = hookLines(await loadLyrics(await loadLevel(f.id)));
      if (!texts.length) throw new Error("no line");
      await sleep(900 + i * 1300);
      if (alive) await c.run(texts);
    } catch {
      c.remove();
    }
  });

  return {
    el,
    onKey(e) {
      if (e.key === "Enter" && !e.repeat) { e.preventDefault(); play(); }
    },
    destroy() { alive = false; },
  };
}
