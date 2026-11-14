// Song menu mockup A, "Library": search, tier filters and sort over a dense list, with a detail panel for
// the selected song. Built for finding a song fast; fully keyboard-driven.
import "./mock-a.css";
import { h, fmtScore, pct } from "../dom";
import { navigate, type Screen } from "../main";
import { navbar, sky } from "../landing";
import { settings, saveSettings } from "../settings";
import {
  loadSongs, difficultyOf, bestOf, lengthAt, sourceFor, startSong, matches, SPEEDS, TIERS,
  type Song, type TierName,
} from "./songs";

type SortKey = "title" | "artist" | "difficulty" | "length";
const SORTS: { key: SortKey; label: string }[] = [
  { key: "title", label: "Title" }, { key: "artist", label: "Artist" },
  { key: "difficulty", label: "Difficulty" }, { key: "length", label: "Length" },
];
const tierCls = (t: TierName) => `t-${t.toLowerCase()}`;
const byText = (a: string, b: string) => a.localeCompare(b, "en", { sensitivity: "base" });

function cover(song: Song, cls: string): HTMLElement {
  const src = song.art ?? song.thumb;
  const box = h("div", { class: cls });
  if (src) box.append(h("img", { src, alt: "", loading: "lazy", decoding: "async" }));
  else box.append(h("span", {}, song.title.slice(0, 1)));
  return box;
}

export async function mockAScreen(): Promise<Screen> {
  const songs = await loadSongs();
  if (!SPEEDS.includes(settings.speed)) settings.speed = 1;

  let query = "";
  let tierFilter: TierName | "All" = "All";
  let sort: SortKey = "title";
  let shown: Song[] = [];
  let sel: Song | undefined = songs.find((s) => s.id === settings.levelId) ?? songs[0];
  const rows = new Map<string, HTMLElement>();

  // ---------- left: search, filters, list ----------
  const search = h("input", {
    class: "ma-search-input", type: "search", placeholder: "Search songs or artists", "aria-label": "Search songs",
    autocomplete: "off", spellcheck: "false",
  }) as HTMLInputElement;
  const chips = h("div", { class: "ma-chips", role: "group", "aria-label": "Difficulty" });
  const sortSel = h("div", { class: "ma-sort", role: "group", "aria-label": "Sort by" });
  const count = h("span", { class: "ma-count" });
  const list = h("div", { class: "ma-list", role: "listbox", "aria-label": "Songs" });
  const empty = h("p", { class: "ma-empty hidden" }, "No songs match.");

  // ---------- right: detail ----------
  const detail = h("aside", { class: "ma-detail" });

  function tierCounts(): Map<string, number> {
    const m = new Map<string, number>();
    for (const s of songs) if (matches(s, query)) {
      const t = difficultyOf(s, settings.speed).tier;
      m.set(t, (m.get(t) ?? 0) + 1);
      m.set("All", (m.get("All") ?? 0) + 1);
    }
    return m;
  }

  function renderChips() {
    const n = tierCounts();
    chips.replaceChildren(...(["All", ...TIERS] as const).map((t) =>
      h("button", {
        class: `ma-chip${t === tierFilter ? " on" : ""}${t !== "All" ? " " + tierCls(t) : ""}`,
        "aria-pressed": String(t === tierFilter),
        onclick: () => { tierFilter = t; refresh(); },
      }, h("span", { class: "ma-chip-name" }, t), h("span", { class: "ma-chip-n" }, String(n.get(t) ?? 0)))));
  }

  function renderSort() {
    sortSel.replaceChildren(h("span", { class: "ma-sort-label" }, "Sort"), ...SORTS.map((s) =>
      h("button", {
        class: `ma-sort-opt${s.key === sort ? " on" : ""}`, "aria-pressed": String(s.key === sort),
        onclick: () => { sort = s.key; refresh(); },
      }, s.label)));
  }

  function sorted(arr: Song[]): Song[] {
    const sp = settings.speed;
    const cmp: Record<SortKey, (a: Song, b: Song) => number> = {
      title: (a, b) => byText(a.title, b.title),
      artist: (a, b) => byText(a.artist, b.artist) || byText(a.title, b.title),
      difficulty: (a, b) => difficultyOf(a, sp).needs - difficultyOf(b, sp).needs || byText(a.title, b.title),
      length: (a, b) => a.duration - b.duration || byText(a.title, b.title),
    };
    return [...arr].sort(cmp[sort]);
  }

  function row(s: Song): HTMLElement {
    const d = difficultyOf(s, settings.speed);
    const best = bestOf(s, settings.speed);
    const el = h("div", {
      class: "ma-row", role: "option", "aria-selected": "false", "data-id": s.id,
      onclick: () => select(s),
      ondblclick: () => startSong(s, settings.speed),
    },
      cover(s, "ma-row-cover"),
      h("div", { class: "ma-row-main" }, h("span", { class: "ma-row-title" }, s.title), h("span", { class: "ma-row-artist" }, s.artist)),
      h("span", { class: "ma-row-len" }, lengthAt(s, settings.speed)),
      h("span", { class: `ma-row-diff ${d.cls}` }, h("i", {}), h("b", {}, String(d.needs)), h("small", {}, "wpm")),
      h("span", { class: `ma-row-best${best ? " g-" + best.grade : ""}` }, best ? best.grade : "–"));
    return el;
  }

  function refresh() {
    shown = sorted(songs.filter((s) => matches(s, query) && (tierFilter === "All" || difficultyOf(s, settings.speed).tier === tierFilter)));
    rows.clear();
    list.replaceChildren(...shown.map((s) => { const r = row(s); rows.set(s.id, r); return r; }));
    empty.classList.toggle("hidden", shown.length > 0);
    count.textContent = `${shown.length} ${shown.length === 1 ? "song" : "songs"}`;
    renderChips();
    renderSort();
    if (!sel || !shown.includes(sel)) sel = shown[0] ?? sel;
    markSelected(true);
    renderDetail();
  }

  function markSelected(scroll: boolean) {
    rows.forEach((r, id) => {
      const on = id === sel?.id;
      r.classList.toggle("sel", on);
      r.setAttribute("aria-selected", String(on));
    });
    const r = sel && rows.get(sel.id);
    if (r && scroll) r.scrollIntoView({ block: "nearest" });
  }

  function select(s: Song, scroll = false) {
    if (sel === s) return;
    sel = s;
    settings.levelId = s.id;
    saveSettings();
    markSelected(scroll);
    renderDetail();
  }

  function setSpeed(sp: number) {
    if (sp === settings.speed) return;
    settings.speed = sp;
    saveSettings();
    refresh(); // difficulty, tier and length change with speed
  }

  function stat(label: string, value: Node | string) {
    return h("div", { class: "ma-stat" }, h("span", { class: "ma-stat-label" }, label), h("span", { class: "ma-stat-value" }, value));
  }

  function renderDetail() {
    const s = sel;
    if (!s) { detail.replaceChildren(h("p", { class: "ma-empty" }, "No song selected.")); return; }
    const sp = settings.speed;
    const d = difficultyOf(s, sp);
    const best = bestOf(s, sp);
    const src = sourceFor(s);
    detail.replaceChildren(
      h("div", { class: "ma-detail-top" },
        cover(s, "ma-detail-cover"),
        h("div", { class: "ma-detail-head" },
          h("span", { class: `ma-detail-tier ${d.cls}` }, d.tier),
          h("h2", { class: "ma-detail-title" }, s.title),
          h("p", { class: "ma-detail-artist" }, s.artist))),
      h("div", { class: "ma-speeds", role: "group", "aria-label": "Speed" }, ...SPEEDS.map((v) =>
        h("button", { class: `ma-speed${v === sp ? " on" : ""}`, "aria-pressed": String(v === sp), onclick: () => setSpeed(v) }, `${v}×`))),
      h("div", { class: "ma-stats" },
        stat("Needs", h("span", { class: d.cls }, `${d.needs} wpm`)),
        stat("Hardest", `${d.burst} wpm`),
        stat("Length", lengthAt(s, sp)),
        stat("Lines", String(s.lines)),
        stat("Best", best ? `${best.grade} · ${pct(best.accuracy, 0)}` : "–"),
        stat("Score", best ? fmtScore(best.score) : "–")),
      h("button", { class: "ma-play", disabled: !src, onclick: () => startSong(s, sp) },
        h("span", { class: "ma-play-icon", "aria-hidden": "true" }), "Play"),
      h("p", { class: "ma-detail-foot" },
        src === "youtube" ? "Plays from YouTube" : src === "local" ? "Plays from local audio" : "No audio available",
        h("span", {}, h("kbd", {}, "Enter"), " play  ", h("kbd", {}, "← →"), " speed")),
    );
  }

  search.addEventListener("input", () => { query = search.value; refresh(); });

  const el = h("div", { class: "landing" },
    sky(),
    navbar(),
    h("main", { class: "ma" },
      h("section", { class: "ma-browse" },
        h("div", { class: "ma-tools" },
          h("label", { class: "ma-search" }, h("span", { class: "ma-search-icon", "aria-hidden": "true" }), search, h("kbd", { class: "ma-slash" }, "/")),
          chips,
          h("div", { class: "ma-bar" }, count, sortSel)),
        h("div", { class: "ma-head", "aria-hidden": "true" },
          h("span", {}), h("span", {}, "Song"), h("span", {}, "Length"), h("span", {}, "Needs"), h("span", {}, "Best")),
        list, empty),
      detail));

  refresh();
  // start with the selected song in the middle of the list (only the list scrolls; on phones the page does)
  requestAnimationFrame(() => {
    const r = sel && rows.get(sel.id);
    if (r && list.scrollHeight > list.clientHeight) list.scrollTop = r.offsetTop - list.clientHeight / 2 + r.offsetHeight / 2;
  });

  return {
    el,
    onKey(e) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const inSearch = document.activeElement === search;
      if (e.key === "Escape") {
        e.preventDefault();
        if (inSearch) { if (search.value) { search.value = ""; query = ""; refresh(); } else search.blur(); }
        else navigate("mocks");
        return;
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!shown.length) return;
        const i = sel ? shown.indexOf(sel) : -1;
        const j = Math.max(0, Math.min(shown.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)));
        select(shown[j], true);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (sel) startSong(sel, settings.speed);
        return;
      }
      if (inSearch) return; // typing
      if (e.key === "/") { e.preventDefault(); search.focus(); search.select(); return; }
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        const i = SPEEDS.indexOf(settings.speed) + (e.key === "ArrowLeft" ? -1 : 1);
        setSpeed(SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, i))]);
      }
    },
  };
}
