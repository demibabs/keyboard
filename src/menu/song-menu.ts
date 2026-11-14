// Song menu (#/play), "Shelves": discovery like a music app. Rows of album covers (jump back in,
// warm-ups, one per tier, more from an artist); searching swaps the rows for a grid of matches. A song
// opens in a drawer (a bottom sheet on phones) to pick the speed and play. With local audio (dev) the
// drawer can also switch the audio source and open the chart editor.
import "./menu.css";
import "./song-menu.css";
import { h, fmtScore, pct } from "../dom";
import { go, navigate, type Screen } from "../main";
import { loadLyrics } from "../lyrics";
import { editorScreen } from "../editor";
import { navbar, rng, sky } from "../landing";
import { settings, saveSettings } from "../settings";
import {
  bestOf, difficultyOf, lengthAt, loadSongs, matches, sourceFor, startSong, SPEEDS, TIERS, type Song,
} from "./songs";

const WPM_RANGE: Record<string, string> = {
  Easy: "under 45 WPM", Normal: "45–70 WPM", Hard: "70–100 WPM", Expert: "100–140 WPM", Insane: "140+ WPM",
};

/** Faint faceted triangles (the GD-block pattern), as a CSS background value. */
function facets(seed: number, color: string): string {
  const r = rng(seed);
  const T = 28, W = 280, H = 140;
  let p = "";
  for (let y = 0; y < H; y += T) for (let x = 0; x < W; x += T) {
    const X = x + T, Y = y + T;
    const tris = r() < 0.5 ? [`M${x} ${y}H${X}L${x} ${Y}Z`, `M${X} ${y}V${Y}H${x}Z`] : [`M${x} ${y}H${X}V${Y}Z`, `M${x} ${y}V${Y}H${X}Z`];
    for (const d of tris) {
      const dark = r() < 0.4;
      p += `<path d='${d}' fill='${dark ? "#03051a" : color}' fill-opacity='${(dark ? 0.06 + r() * 0.1 : 0.02 + r() * 0.045).toFixed(3)}'/>`;
    }
  }
  return `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='${W}' height='${H}'>${p}</svg>`)}")`;
}

const TIER_RGB: Record<string, string> = {
  Easy: "143, 227, 192", Normal: "143, 211, 255", Hard: "253, 227, 145", Expert: "255, 179, 138", Insane: "255, 143, 176",
};

function cover(s: Song, cls: string): HTMLElement {
  const wrap = h("div", { class: `sm-cover ${cls}` });
  const src = s.art ?? s.thumb;
  if (src) {
    const img = h("img", { src, alt: "", loading: "lazy", draggable: "false" });
    img.addEventListener("error", () => {
      if (s.art && img.src === s.art && s.thumb) img.src = s.thumb;
      else img.remove();
    });
    wrap.append(img);
  }
  return wrap;
}

interface Shelf { title: string; sub?: string; songs: Song[] }

export async function songMenuScreen(): Promise<Screen> {
  const songs = await loadSongs();
  let speed = SPEEDS.includes(settings.speed) ? settings.speed : 1;
  let query = "";
  let showAll = false;
  let openSong: Song | null = null;
  let lastFocus: HTMLElement | null = null;

  // ---------- header ----------
  const search = h("input", {
    class: "sm-search-input", type: "search", placeholder: "Search songs or artists", "aria-label": "Search songs",
    autocomplete: "off", spellcheck: "false",
  });
  const speedRow = h("div", { class: "sm-speeds", role: "group", "aria-label": "Speed" });
  const allBtn = h("button", { class: "sm-all", onclick: () => { showAll = !showAll; query = ""; search.value = ""; render(); } });
  const head = h("header", { class: "sm-head" },
    h("div", { class: "sm-titles" },
      h("h1", {}, "Songs"),
      h("p", {}, `${songs.length} songs`)),
    h("div", { class: "sm-tools" },
      h("label", { class: "sm-search" },
        h("span", { class: "sm-search-icon", "aria-hidden": "true" }), search, h("kbd", {}, "/")),
      h("div", { class: "sm-speed-wrap" }, h("span", { class: "sm-label" }, "Speed"), speedRow),
      allBtn));
  const body = h("main", { class: "sm-body" });

  // ---------- drawer ----------
  const scrim = h("div", { class: "sm-scrim", onclick: () => close() });
  const drawer = h("aside", { class: "sm-drawer", role: "dialog", "aria-modal": "true", "aria-label": "Song" });

  const page = h("div", { class: "landing sm-page" }, sky(), navbar(), h("div", { class: "sm-wrap" }, head, body), scrim, drawer);

  function renderSpeeds() {
    speedRow.replaceChildren(...SPEEDS.map((s) =>
      h("button", { class: "sm-speed" + (s === speed ? " on" : ""), "aria-pressed": String(s === speed), onclick: () => setSpeed(s) }, `${s}×`)));
  }
  function setSpeed(s: number) {
    if (s === speed) return;
    speed = s;
    settings.speed = s;
    saveSettings();
    renderSpeeds();
    if (openSong) renderDrawer(openSong);
    else render();
  }

  // ---------- cards ----------
  function card(s: Song): HTMLButtonElement {
    const d = difficultyOf(s, speed);
    return h("button", { class: "sm-card", "data-id": s.id, onclick: (e: MouseEvent) => { if (!dragged) open(s, e.currentTarget as HTMLElement); } },
      cover(s, "sm-card-cover"),
      h("span", { class: "sm-card-title" }, s.title),
      h("span", { class: "sm-card-meta" },
        h("span", { class: "sm-card-artist" }, s.artist),
        h("span", { class: `sm-tier ${d.cls}` }, d.tier)));
  }

  function shelves(): Shelf[] {
    const by = (a: Song, b: Song) => difficultyOf(a, speed).needs - difficultyOf(b, speed).needs;
    const tierOf = (s: Song) => difficultyOf(s, speed).tier;
    const out: Shelf[] = [];
    const played = songs.filter((s) => SPEEDS.some((sp) => bestOf(s, sp)));
    if (played.length) out.push({ title: "Jump back in", songs: played });
    out.push({ title: "Warm-ups", sub: `Easy and Normal at ${speed}×`, songs: songs.filter((s) => tierOf(s) === "Easy" || tierOf(s) === "Normal").sort(by) });
    for (const t of TIERS.slice(2)) out.push({ title: t, sub: WPM_RANGE[t], songs: songs.filter((s) => tierOf(s) === t).sort(by) });
    const artists = new Map<string, Song[]>();
    for (const s of songs) {
      const a = s.artist.split(/,| & | feat\.| ft\./i)[0].trim();
      artists.set(a, [...(artists.get(a) ?? []), s]);
    }
    [...artists].filter(([, l]) => l.length >= 3).sort((a, b) => b[1].length - a[1].length).slice(0, 6)
      .forEach(([a, l]) => out.push({ title: `More from ${a}`, songs: l }));
    return out.filter((s) => s.songs.length);
  }

  // drag-to-scroll (mouse); a drag shouldn't count as a click on the card under it
  let dragged = false;
  function draggable(track: HTMLElement) {
    let startX = 0, startLeft = 0, down = false;
    track.addEventListener("pointerdown", (e) => {
      if (e.pointerType !== "mouse" || e.button !== 0) return;
      down = true; dragged = false; startX = e.clientX; startLeft = track.scrollLeft;
    });
    window.addEventListener("pointermove", (e) => {
      if (!down) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 6) { dragged = true; track.classList.add("dragging"); }
      if (dragged) track.scrollLeft = startLeft - dx;
    });
    window.addEventListener("pointerup", () => {
      if (!down) return;
      down = false;
      track.classList.remove("dragging");
      setTimeout(() => (dragged = false), 0);
    });
  }

  function shelfEl(sh: Shelf): HTMLElement {
    const track = h("div", { class: "sm-track" }, ...sh.songs.map(card));
    const prev = h("button", { class: "sm-arrow prev", "aria-label": `Scroll ${sh.title} left`, onclick: () => track.scrollBy({ left: -track.clientWidth * 0.8, behavior: "smooth" }) });
    const next = h("button", { class: "sm-arrow next", "aria-label": `Scroll ${sh.title} right`, onclick: () => track.scrollBy({ left: track.clientWidth * 0.8, behavior: "smooth" }) });
    const ends = () => {
      prev.disabled = track.scrollLeft < 4;
      next.disabled = track.scrollLeft + track.clientWidth > track.scrollWidth - 4;
      track.classList.toggle("more", !next.disabled);
    };
    track.addEventListener("scroll", ends, { passive: true });
    requestAnimationFrame(ends);
    draggable(track);
    return h("section", { class: "sm-shelf" },
      h("div", { class: "sm-shelf-head" },
        h("h2", {}, sh.title),
        sh.sub ? h("span", { class: "sm-shelf-sub" }, sh.sub) : "",
        h("span", { class: "sm-shelf-count" }, String(sh.songs.length)),
        h("div", { class: "sm-arrows" }, prev, next)),
      track);
  }

  function render() {
    allBtn.textContent = showAll ? "Shelves" : "All A–Z";
    allBtn.classList.toggle("on", showAll);
    const q = query.trim();
    if (q || showAll) {
      const list = (q ? songs.filter((s) => matches(s, q)) : [...songs]).sort((a, b) => a.title.localeCompare(b.title));
      body.replaceChildren(
        q ? h("p", { class: "sm-results" }, `${list.length} ${list.length === 1 ? "match" : "matches"} for “${q}”`) : "",
        list.length ? h("div", { class: "sm-grid" }, ...list.map(card))
          : h("p", { class: "sm-empty" }, "Nothing matches that. Try an artist, or part of a title."));
    } else {
      body.replaceChildren(...shelves().map(shelfEl));
    }
  }

  // ---------- drawer ----------
  function stat(label: string, value: Node | string) {
    return h("div", { class: "sm-stat" }, h("span", { class: "sm-stat-label" }, label), h("span", { class: "sm-stat-value" }, value));
  }
  function renderDrawer(s: Song) {
    const d = difficultyOf(s, speed);
    const best = bestOf(s, speed);
    const src = sourceFor(s);
    const playBtn = h("button", { class: "hero-play sm-play", onclick: () => play(), disabled: !src },
      h("span", { class: "hero-play-icon", "aria-hidden": "true" }), "Play");
    const art = h("div", { class: "sm-drawer-art" }, cover(s, "sm-drawer-cover"));
    art.style.setProperty("--sm-facets", facets(s.id.length * 31 + s.title.length, `rgb(${TIER_RGB[d.tier]})`));
    art.style.setProperty("--sm-tint", TIER_RGB[d.tier]);
    drawer.replaceChildren(
      h("button", { class: "sm-close", "aria-label": "Close", onclick: () => close() }),
      art,
      h("div", { class: "sm-drawer-body" },
        h("p", { class: `sm-drawer-tier ${d.cls}` }, `${d.tier} at ${speed}×`),
        h("h2", { class: "sm-drawer-title" }, s.title),
        h("p", { class: "sm-drawer-artist" }, s.artist),
        h("div", { class: "sm-speeds sm-drawer-speeds", role: "group", "aria-label": "Speed" }, ...SPEEDS.map((sp) =>
          h("button", { class: "sm-speed" + (sp === speed ? " on" : ""), "aria-pressed": String(sp === speed), onclick: () => setSpeed(sp) }, `${sp}×`))),
        h("div", { class: "sm-stats" },
          stat("Needs", `~${d.needs} WPM`),
          stat("Hardest line", `${d.burst} WPM`),
          stat("Length", lengthAt(s, speed)),
          stat("Lines", String(s.lines)),
          stat("Best", best ? `${fmtScore(best.score)} · ${best.grade} · ${pct(best.accuracy)}` : "Not played yet"),
          stat("Audio", s.local && s.youtube
            ? h("button", { class: "sm-source", onclick: () => toggleSource(), title: "Switch audio source (A)" },
              src === "local" ? "Local file" : "YouTube")
            : src === "local" ? "Local file" : src === "youtube" ? "YouTube" : "Unavailable")),
        playBtn,
        h("p", { class: "sm-drawer-hint" }, h("kbd", {}, "Enter"), " play  ", h("kbd", {}, "←→"), " speed  ", h("kbd", {}, "Esc"), " close"),
        s.local ? h("button", { class: "sm-edit", onclick: () => edit() }, "Edit timing (E)") : ""));
  }
  /** Local audio or the YouTube video, for songs that have both (dev). */
  function toggleSource() {
    settings.audioSource = settings.audioSource === "local" ? "youtube" : "local";
    saveSettings();
    if (openSong) renderDrawer(openSong);
  }
  /** Chart editor (needs the local audio for its waveform). */
  function edit() {
    const s = openSong;
    if (s?.local) go(async () => editorScreen(await loadLyrics(s.level)));
  }
  function open(s: Song, from?: HTMLElement) {
    openSong = s;
    lastFocus = from ?? (document.activeElement as HTMLElement | null);
    renderDrawer(s);
    page.classList.add("sm-open");
    (drawer.querySelector(".sm-play") as HTMLElement | null)?.focus({ preventScroll: true });
  }
  function close() {
    if (!openSong) return;
    openSong = null;
    page.classList.remove("sm-open");
    render(); // speed may have changed the tiers
    const back = lastFocus?.dataset.id && body.querySelector<HTMLElement>(`.sm-card[data-id="${lastFocus.dataset.id}"]`);
    (back || null)?.focus({ preventScroll: false });
  }
  function play() {
    if (openSong) startSong(openSong, speed);
  }

  // ---------- keyboard ----------
  /** Cards as rows: one row per shelf, or the grid's visual rows. */
  function rows(): HTMLElement[][] {
    const grid = body.querySelector(".sm-grid");
    if (grid) {
      const cards = [...grid.querySelectorAll<HTMLElement>(".sm-card")];
      const out: HTMLElement[][] = [];
      for (const c of cards) {
        const last = out[out.length - 1];
        if (last && last[0].offsetTop === c.offsetTop) last.push(c);
        else out.push([c]);
      }
      return out;
    }
    return [...body.querySelectorAll(".sm-track")].map((t) => [...t.querySelectorAll<HTMLElement>(".sm-card")]);
  }
  function focusCard(c: HTMLElement | undefined) {
    if (!c) return;
    c.focus({ preventScroll: true });
    c.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
  }
  function moveFocus(key: string) {
    const rs = rows();
    const cur = document.activeElement as HTMLElement | null;
    let r = rs.findIndex((row) => row.includes(cur!));
    if (r < 0) return focusCard(rs[0]?.[0]);
    let i = rs[r].indexOf(cur!);
    if (key === "ArrowLeft") i = Math.max(0, i - 1);
    else if (key === "ArrowRight") i = Math.min(rs[r].length - 1, i + 1);
    else {
      // keep roughly the same horizontal position when changing rows
      const x = cur!.getBoundingClientRect().left;
      r = Math.max(0, Math.min(rs.length - 1, r + (key === "ArrowUp" ? -1 : 1)));
      if (key === "ArrowUp" && rs.indexOf(rs[r]) === r && cur === rs[0][i] && r === 0) { search.focus(); return; }
      let bestI = 0, bestD = Infinity;
      rs[r].forEach((c, k) => { const dx = Math.abs(c.getBoundingClientRect().left - x); if (dx < bestD) { bestD = dx; bestI = k; } });
      i = bestI;
    }
    focusCard(rs[r][i]);
  }

  search.addEventListener("input", () => { query = search.value; showAll = false; render(); });

  renderSpeeds();
  render();

  return {
    el: page,
    onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key;
      if (openSong) {
        if (k === "Escape") { e.preventDefault(); close(); }
        else if (k === "Enter" && !e.repeat && (document.activeElement === drawer.querySelector(".sm-play") || !drawer.contains(document.activeElement))) { e.preventDefault(); play(); }
        else if ((k === "a" || k === "A") && openSong.local && openSong.youtube) { e.preventDefault(); toggleSource(); }
        else if ((k === "e" || k === "E") && openSong.local) { e.preventDefault(); edit(); }
        else if (k === "ArrowLeft" || k === "ArrowRight") {
          e.preventDefault();
          const i = SPEEDS.indexOf(speed) + (k === "ArrowLeft" ? -1 : 1);
          setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, i))]);
        } else if (k === "Tab") {
          // keep focus inside the drawer
          const f = [...drawer.querySelectorAll<HTMLElement>("button:not([disabled])")];
          const at = f.indexOf(document.activeElement as HTMLElement);
          if (e.shiftKey ? at <= 0 : at === f.length - 1) { e.preventDefault(); f[e.shiftKey ? f.length - 1 : 0]?.focus(); }
        }
        return;
      }
      if (document.activeElement === search) {
        if (k === "Escape") {
          e.preventDefault();
          if (search.value) { search.value = ""; query = ""; render(); } else search.blur();
        } else if (k === "ArrowDown" || k === "Enter") { e.preventDefault(); focusCard(rows()[0]?.[0]); }
        return;
      }
      if (k === "/") { e.preventDefault(); search.focus(); return; }
      if (k.startsWith("Arrow")) { e.preventDefault(); moveFocus(k); return; }
      if (k === "Escape") { e.preventDefault(); navigate(""); return; }
      // start typing anywhere to search
      if (k.length === 1 && /\S/.test(k) && !(document.activeElement instanceof HTMLButtonElement && k === " ")) search.focus();
    },
  };
}
