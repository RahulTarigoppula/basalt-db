import { db, DbError, cellText, isNumeric } from "../client.js";
import type { WireResult } from "../worker/protocol.js";
import { h, fmtMs, fmtInt, currentQuery, pendingCells, toast } from "../ui.js";

const STORE = "basalt.cells";
const ROW_H = 24;
const OVERSCAN = 12;

const DEFAULT_CELLS = [
  "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT, created TEXT DEFAULT '2026-10-19');\nINSERT INTO notes (title, body) VALUES ('hello', 'Basalt runs entirely in this tab'), ('persistence', 'reload the page: this table is still here');",
  "SELECT id, title, length(body) AS body_len, created FROM notes ORDER BY id",
];

function loadCells(): string[] {
  try { const v = localStorage.getItem(STORE); if (v) return JSON.parse(v) as string[]; } catch { /* ignore */ }
  return [...DEFAULT_CELLS];
}
function saveCells(cells: string[]): void {
  try { localStorage.setItem(STORE, JSON.stringify(cells)); } catch { /* ignore */ }
}

/** Virtualised results grid: only the visible window of rows exists in the DOM. */
export function resultsGrid(res: WireResult): HTMLElement {
  const wrap = h("div", { class: "grid" });
  const table = h("table");
  const thead = h("thead", {}, h("tr", {}, h("th", { class: "rownum" }, "#"), ...res.columns.map((c) => h("th", {}, c.name, h("span", { class: "type" }, c.type === "ANY" ? "" : c.type.toLowerCase())))));
  const tbody = h("tbody");
  table.append(thead, tbody);
  wrap.appendChild(table);
  const n = res.rows.length;
  let lastStart = -1, lastEnd = -1;
  const render = (): void => {
    const top = wrap.scrollTop;
    const height = wrap.clientHeight || 420;
    const start = Math.max(0, Math.floor(top / ROW_H) - OVERSCAN);
    const end = Math.min(n, Math.ceil((top + height) / ROW_H) + OVERSCAN);
    if (start === lastStart && end === lastEnd) return;
    lastStart = start; lastEnd = end;
    const frag = document.createDocumentFragment();
    const topRow = h("tr", { class: "spacer-row" }, h("td", { colspan: res.columns.length + 1, style: { height: `${start * ROW_H}px` } }));
    frag.appendChild(topRow);
    for (let i = start; i < end; i++) {
      const row = res.rows[i]!;
      const tr = h("tr", {}, h("td", { class: "rownum" }, String(i + 1)));
      for (const c of row) {
        const td = h("td", { class: c === null ? "null" : isNumeric(c) ? "num" : "" }, cellText(c));
        if (typeof c === "string" && c.length > 60) td.title = c;
        tr.appendChild(td);
      }
      frag.appendChild(tr);
    }
    frag.appendChild(h("tr", { class: "spacer-row" }, h("td", { colspan: res.columns.length + 1, style: { height: `${Math.max(0, n - end) * ROW_H}px` } })));
    tbody.replaceChildren(frag);
  };
  wrap.addEventListener("scroll", render, { passive: true });
  requestAnimationFrame(render);
  render();
  return wrap;
}

export function notebookScreen(root: HTMLElement): () => void {
  const firstVisit = localStorage.getItem(STORE) === null;
  const cells = loadCells();
  const params = new URLSearchParams(location.search || location.hash.split("?")[1] || "");
  const q = params.get("q");
  if (q) { cells[0] = q; }
  for (const sql of pendingCells.take()) cells.push(sql);
  saveCells(cells);

  const list = h("div", { class: "cells" });
  const head = h("div", { class: "screen-head" },
    h("h1", {}, "Notebook"),
    h("p", {}, "SQL cells over a database file that lives in this browser. ", h("kbd", {}, "Ctrl"), " + ", h("kbd", {}, "Enter"), " runs a cell."),
    h("div", { class: "spacer" }),
    h("button", { class: "btn", onClick: () => runAll() }, "Run all"),
    h("button", { class: "btn", onClick: () => addCell("") }, "+ Cell"),
    h("button", { class: "btn ghost", onClick: () => exportFile() }, "Download .basalt"),
    h("button", { class: "btn ghost danger", onClick: () => resetDb() }, "Reset database"),
  );
  root.append(head, list);

  const cellEls: { el: HTMLElement; ta: HTMLTextAreaElement; run: () => Promise<void> }[] = [];

  function persist(): void { saveCells(cellEls.map((c) => c.ta.value)); }

  function addCell(sql: string, focus = true): void {
    const ta = h("textarea", { spellcheck: false, placeholder: "SELECT ..." }) as HTMLTextAreaElement;
    ta.value = sql;
    const meta = h("div", { class: "cell-meta" }, h("span", { class: "muted" }, "not run"));
    const out = h("div");
    const runBtn = h("button", { class: "btn primary", onClick: () => run() }, "Run");
    const explainBtn = h("button", { class: "btn", title: "Open in the plan visualiser", onClick: () => { currentQuery.set(ta.value); location.hash = "#/plan"; } }, "Plan");
    const delBtn = h("button", { class: "btn ghost", title: "Delete cell", onClick: () => { el.remove(); cellEls.splice(cellEls.indexOf(entry), 1); persist(); } }, "x");
    const el = h("div", { class: "card cell" },
      h("div", { class: "cell-editor" }, ta),
      h("div", { class: "cell-meta" }, meta, h("div", { class: "cell-actions" }, explainBtn, delBtn, runBtn)),
      out,
    );
    const autosize = (): void => { ta.style.height = "auto"; ta.style.height = `${Math.max(76, ta.scrollHeight + 2)}px`; };
    ta.addEventListener("input", () => { persist(); autosize(); });
    ta.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); run(); }
      else if (e.key === "Tab") {
        e.preventDefault();
        const s = ta.selectionStart, end = ta.selectionEnd;
        ta.value = `${ta.value.slice(0, s)}  ${ta.value.slice(end)}`;
        ta.selectionStart = ta.selectionEnd = s + 2;
        persist();
      }
    });
    const run = async (): Promise<void> => {
      const sql = ta.value.trim();
      if (!sql) return;
      runBtn.disabled = true;
      meta.replaceChildren(h("span", { class: "muted" }, "running"));
      currentQuery.set(sql);
      try {
        const results = await db.exec(sql);
        const last = results[results.length - 1];
        const totalMs = results.reduce((a, r) => a + r.ms, 0);
        const parts: (HTMLElement | string)[] = [];
        if (last && last.columns.length) parts.push(h("span", {}, h("span", { class: "num" }, fmtInt(last.rows.length)), ` row${last.rows.length === 1 ? "" : "s"}`));
        const affected = results.reduce((a, r) => a + r.rowsAffected, 0);
        if (affected) parts.push(h("span", {}, h("span", { class: "num" }, fmtInt(affected)), " affected"));
        if (results.length > 1) parts.push(h("span", { class: "muted" }, `${results.length} statements`));
        parts.push(h("span", {}, h("span", { class: "num" }, fmtMs(totalMs))));
        meta.replaceChildren(...parts);
        out.replaceChildren(last && last.columns.length ? resultsGrid(last) : "");
      } catch (e) {
        const info = e instanceof DbError ? e.info : { name: "Error", message: String(e) };
        const where = info.line !== undefined ? ` (line ${info.line}${info.col !== undefined ? `:${info.col}` : ""})` : "";
        meta.replaceChildren(h("span", { class: "err" }, `${info.name}: ${info.message}${where}`));
        out.replaceChildren();
        if (info.line !== undefined) {
          // Move the caret to the error position so the user can see it.
          const lines = ta.value.split("\n");
          let pos = 0;
          for (let i = 0; i < info.line - 1 && i < lines.length; i++) pos += lines[i]!.length + 1;
          pos += Math.max(0, (info.col ?? 1) - 1);
          ta.focus(); ta.setSelectionRange(pos, pos);
        }
      } finally { runBtn.disabled = false; }
    };
    const entry = { el, ta, run };
    cellEls.push(entry);
    list.appendChild(el);
    autosize();
    if (focus) ta.focus();
  }

  async function runAll(): Promise<void> { for (const c of cellEls) await c.run(); }

  async function exportFile(): Promise<void> {
    try {
      const bytes = await db.call("export");
      const blob = new Blob([bytes as BlobPart], { type: "application/octet-stream" });
      const a = h("a", { href: URL.createObjectURL(blob), download: "notebook.basalt" });
      document.body.appendChild(a); a.click(); a.remove();
      toast(`Exported ${fmtInt(bytes.byteLength)} bytes`);
    } catch (e) { toast(`Export failed: ${(e as Error).message}`); }
  }

  async function resetDb(): Promise<void> {
    if (!confirm("Delete notebook.basalt and start from an empty database? Cells are kept.")) return;
    await db.call("reset");
    db.changed();
    toast("Database reset");
  }

  for (const sql of cells) addCell(sql, false);
  if (q) cellEls[0]?.run();
  else if (firstVisit) runAll();
  else cellEls[cellEls.length - 1]?.run();
  return () => { persist(); };
}
