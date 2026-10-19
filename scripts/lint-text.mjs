#!/usr/bin/env node
/**
 * Text lint: fails when a tracked text file contains typographic characters the project bans in prose and
 * code (em dash U+2014, en dash U+2013, curly quotes U+2018/U+2019/U+201C/U+201D, arrow U+2192).
 * Corpora under `data/` and `web/public/data/` are exempt, as are binary files.
 *
 *   npm run lint:text
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const BANNED = new Map([
  ["—", "em dash (U+2014)"],
  ["–", "en dash (U+2013)"],
  ["‘", "left single quote (U+2018)"],
  ["’", "right single quote (U+2019)"],
  ["“", "left double quote (U+201C)"],
  ["”", "right double quote (U+201D)"],
  ["→", "rightwards arrow (U+2192)"],
  ["…", "horizontal ellipsis (U+2026)"],
  ["↔", "left right arrow (U+2194)"],
  ["←", "leftwards arrow (U+2190)"],
  ["⇒", "double arrow (U+21D2)"],
  ["•", "bullet (U+2022)"],
  ["×", "multiplication sign (U+00D7)"],
]);
const EXEMPT_DIRS = ["data/", "web/public/data/", "scripts/lint-text.mjs"];
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|safetensors|bin|pdf|zip)$/i;
const pattern = new RegExp(`[${[...BANNED.keys()].join("")}]`, "g");

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((f) => f && !EXEMPT_DIRS.some((d) => f.startsWith(d)) && !BINARY_EXT.test(f));

let problems = 0;
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue; // deleted in the working tree
  }
  if (!pattern.test(text)) continue;
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    for (const m of line.matchAll(pattern)) {
      problems++;
      console.log(`${file}:${i + 1}:${(m.index ?? 0) + 1}: ${BANNED.get(m[0])}`);
    }
  });
}

if (problems) {
  console.error(`lint-text: ${problems} banned character(s) in ${files.length} tracked files. Use plain hyphens, quotes and words instead.`);
  process.exit(1);
}
console.log(`lint-text: ok (${files.length} files checked)`);
