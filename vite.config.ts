import { defineConfig, type Plugin } from "vite";
import fs from "node:fs";
import path from "node:path";

// Dev-only endpoint the chart editor uses to save charts back into public/levels/<id>/chart.json.
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
            if (!fs.existsSync(file)) throw new Error("unknown level");
            const bak = path.join(dir, "chart.orig.json");
            if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
            fs.writeFileSync(file, JSON.stringify(chart, null, 1));
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

export default defineConfig({ plugins: [chartSaver()] });
