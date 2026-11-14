// Song menu mockups: a chooser page (#/mocks) and one route per design (#/mocks/a ...).
import "./menu.css";
import { h } from "../dom";
import type { Screen } from "../main";
import { navbar, sky } from "../landing";

export const MOCKS = [
  { key: "a", name: "Library", about: "A searchable, sortable list with filters on the left and a detail panel on the right. Built for finding a song fast." },
  { key: "b", name: "Shelves", about: "Album covers on rows (featured, by difficulty, by artist), like a music app. A song opens in a panel to pick the speed and play." },
  { key: "c", name: "Song wheel", about: "A rhythm-game style wheel: scroll through songs, the selected one is big with its cover, stats and speed." },
  { key: "d", name: "Star chart", about: "Every song is a star placed by difficulty and length, grouped into tier constellations. Search lights them up; a list is one click away." },
] as const;

export function mocksScreen(): Screen {
  return {
    el: h("div", { class: "landing" }, sky(), navbar(),
      h("section", { class: "mocks" },
        h("h1", {}, "Song menu mockups"),
        h("p", {}, "Four directions for the new song menu. Each one works with the real songs: search, pick a speed, and play."),
        h("div", { class: "mock-grid" }, ...MOCKS.map((m, i) =>
          h("a", { class: "mock-tile", href: `#/mocks/${m.key}` }, h("b", {}, h("span", {}, String.fromCharCode(65 + i)), m.name), h("p", {}, m.about)))))),
  };
}
