import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
// GitHub Pages serves the site at https://rahultarigoppula.github.io/basalt-db/
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: process.env.BASE_PATH ?? "/basalt-db/",
  build: { outDir: "dist", emptyOutDir: true, target: "es2022", sourcemap: true },
  worker: { format: "es" },
  server: { headers: { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" } },
});
