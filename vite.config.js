import { defineConfig } from "vite";
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

// One id per build: baked into the app, sw.js and /version.json, so a page
// can tell when a newer deploy is live.
const BUILD_ID = `${Date.now().toString(36)}-${(process.env.VERCEL_GIT_COMMIT_SHA || "local").slice(0, 7)}`;

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

// Writes dist/sw.js (from src/sw.js, with this build's file list) and
// dist/version.json after the build.
function offlineShell() {
  let root = process.cwd();
  let outDir = "dist";
  return {
    name: "offline-shell",
    apply: "build",
    configResolved(config) {
      root = config.root;
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const files = walk(outDir)
        .map((file) => "/" + relative(outDir, file).split(sep).join("/"))
        .filter((url) => !url.endsWith(".map") && !["/sw.js", "/version.json", "/index.html"].includes(url))
        .sort();
      const html = readFileSync(join(outDir, "index.html"), "utf8");
      const fontCss = [...html.matchAll(/<link[^>]+href="(https:\/\/fonts\.googleapis\.com\/[^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, "&"));
      const sw = readFileSync(resolve(root, "src/sw.js"), "utf8")
        .replace('"__BUILD_ID__"', JSON.stringify(BUILD_ID))
        .replace("__PRECACHE__", JSON.stringify(["/", ...files]))
        .replace("__FONT_CSS__", JSON.stringify(fontCss));
      writeFileSync(join(outDir, "sw.js"), sw);
      writeFileSync(join(outDir, "version.json"), JSON.stringify({ build: BUILD_ID }) + "\n");
    },
  };
}

export default defineConfig({
  define: {
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  plugins: [offlineShell()],
  server: {
    port: 5173,
  },
});
