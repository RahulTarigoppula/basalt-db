import "./styles.css";
import { db } from "./client.js";
import { h, fmtInt } from "./ui.js";
import { notebookScreen } from "./screens/notebook.js";
import { planScreen } from "./screens/plan.js";
import { storageScreen } from "./screens/storage.js";
import { datasetsScreen } from "./screens/datasets.js";
import { benchScreen } from "./screens/bench.js";
import { aboutScreen } from "./screens/about.js";

type Screen = (root: HTMLElement) => void | (() => void);

const ROUTES: Record<string, { title: string; screen: Screen }> = {
  notebook: { title: "Notebook", screen: notebookScreen },
  plan: { title: "Plan", screen: planScreen },
  storage: { title: "Storage", screen: storageScreen },
  datasets: { title: "Datasets", screen: datasetsScreen },
  bench: { title: "Bench", screen: benchScreen },
  about: { title: "About", screen: aboutScreen },
};

const LOGO = `<svg viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="6" fill="currentColor"/><path d="M9 7h9a5 5 0 0 1 3.5 8.6A5.5 5.5 0 0 1 18.5 25H9zM13 11v4h5a2 2 0 0 0 0-4zm0 7v4h5.5a2 2 0 0 0 0-4z" fill="var(--paper)"/></svg>`;

const app = document.getElementById("app")!;
const nav = h("nav", { class: "tabs" });
const backendPill = h("span", { class: "pill" }, h("i", { class: "dot" }), "opening");
const statsText = h("span", {}, "");
const wordmark = h("a", { class: "wordmark", href: "#/notebook" });
wordmark.innerHTML = LOGO;
wordmark.appendChild(document.createTextNode("Basalt"));
app.appendChild(h("header", { class: "topbar" }, wordmark, nav, h("div", { class: "spacer" }), h("div", { class: "status" }, statsText, backendPill)));
const main = h("main");
app.appendChild(main);

for (const [key, r] of Object.entries(ROUTES)) nav.appendChild(h("a", { href: `#/${key}`, "data-route": key }, r.title));

let cleanup: (() => void) | void;
function route(): void {
  const hash = location.hash.replace(/^#\/?/, "").split("?")[0] || "notebook";
  const r = ROUTES[hash] ?? ROUTES["notebook"]!;
  for (const a of nav.querySelectorAll("a")) a.classList.toggle("active", a.dataset["route"] === (ROUTES[hash] ? hash : "notebook"));
  document.title = `${r.title} - Basalt`;
  if (cleanup) cleanup();
  main.replaceChildren();
  cleanup = r.screen(main);
}

async function refreshStats(): Promise<void> {
  try {
    const s = await db.call("stats");
    statsText.textContent = `${fmtInt(s.pageCount)} pages, ${fmtInt(s.freePages)} free, txn ${s.txnId}`;
  } catch { /* not open yet */ }
}

db.ready.then(() => {
  const label = db.backend === "opfs" ? "OPFS" : db.backend === "indexeddb" ? "IndexedDB" : "memory";
  backendPill.replaceChildren(h("i", { class: "dot" }), `${label} / notebook.basalt`);
  backendPill.classList.toggle("warn", db.backend === "memory");
  backendPill.title = db.backend === "opfs" ? "Persisted in the origin private file system of this browser" : db.backend === "indexeddb" ? "Persisted in IndexedDB (flushed after each commit)" : "No persistent storage available: data is lost on reload";
  if (db.openLog.length) backendPill.title += "\n" + db.openLog.join("\n");
  refreshStats();
}).catch((e) => { backendPill.textContent = "open failed"; console.error(e); });
db.onChange(() => { refreshStats(); });

window.addEventListener("hashchange", route);
route();
