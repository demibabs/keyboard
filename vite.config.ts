import { defineConfig, type Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Dev-only endpoint the chart editor uses to save charts back into public/levels/<id>/chart.json
// (then level.json is regenerated from it).
function chartSaver(): Plugin {
  return {
    name: "chart-saver",
    configureServer(server) {
      server.middlewares.use("/api/save-chart", (req, res) => {
        if (req.method !== "POST") { res.statusCode = 405; res.end(); return; }
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const chart = JSON.parse(body);
            if (!/^[a-z0-9-]+$/.test(chart.id)) throw new Error("bad id");
            const dir = path.resolve("public/levels", chart.id);
            const file = path.join(dir, "chart.json");
            if (!fs.existsSync(dir)) throw new Error("unknown level");
            const bak = path.join(dir, "chart.orig.json");
            if (fs.existsSync(file) && !fs.existsSync(bak)) fs.copyFileSync(file, bak);
            delete chart.note;
            fs.writeFileSync(file, JSON.stringify(chart, null, 1));
            execFileSync(process.execPath, ["scripts/levels.ts", "sync", chart.id]);
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true }));
          } catch (e) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: String(e) }));
          }
        });
      });
    },
  };
}

// The release build ships only level.json (+ viz.json) files + index.json (no public dir copy): local audio, full-text
// charts and local.json stay out.
function releaseLevels(): Plugin {
  return {
    name: "release-levels",
    apply: "build",
    generateBundle() {
      const root = path.resolve("public/levels");
      const emit = (rel: string) =>
        this.emitFile({ type: "asset", fileName: `levels/${rel}`, source: fs.readFileSync(path.join(root, rel)) });
      emit("index.json");
      for (const id of JSON.parse(fs.readFileSync(path.join(root, "index.json"), "utf8")).levels) {
        emit(`${id}/level.json`);
        if (fs.existsSync(path.join(root, id, "viz.json"))) emit(`${id}/viz.json`); // music features for the sky
      }
    },
  };
}

export default defineConfig(({ command }) => ({
  base: "./",
  publicDir: command === "build" ? false : "public",
  plugins: [chartSaver(), releaseLevels()],
}));
