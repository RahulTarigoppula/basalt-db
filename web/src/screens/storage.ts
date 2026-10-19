import { db } from "../client.js";
import type { PageInfo } from "../../../src/index.js";
import type { WirePageDetail, TableTreeStats } from "../worker/protocol.js";
import { h, fmtInt } from "../ui.js";

const KIND_VAR: Record<PageInfo["type"], string> = { meta: "--p-meta", interior: "--p-interior", leaf: "--p-leaf", overflow: "--p-overflow", freelist: "--p-freelist", free: "--p-free", unused: "--p-unused" };

function cssVar(name: string): string { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

export function storageScreen(root: HTMLElement): () => void {
  const canvas = h("canvas", { class: "pagemap" }) as HTMLCanvasElement;
  const statsRow = h("div", { class: "stats-row" });
  const treeBody = h("tbody");
  const pageDetail = h("div", { class: "card-body" }, h("p", { class: "muted" }, "Click a page in the map."));
  const tooltip = h("div", { class: "tooltip", style: { display: "none" } });
  document.body.appendChild(tooltip);
  const legend = h("div", { class: "legend" }, ...(Object.keys(KIND_VAR) as PageInfo["type"][]).map((k) => h("span", {}, h("i", { style: { background: `var(${KIND_VAR[k]})` } }), k)));
  const mapInfo = h("span", { class: "muted small" }, "");

  let pages: PageInfo[] = [];
  let cell = 10, cols = 1, selected = -1;

  function drawMap(): void {
    const width = canvas.clientWidth || 600;
    const n = pages.length;
    cell = n <= 400 ? 18 : n <= 2000 ? 12 : n <= 8000 ? 8 : n <= 30000 ? 5 : 3;
    cols = Math.max(1, Math.floor(width / cell));
    const rows = Math.ceil(n / cols);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(width * dpr); canvas.height = Math.floor(rows * cell * dpr);
    canvas.style.height = `${rows * cell}px`;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    const colors = Object.fromEntries((Object.keys(KIND_VAR) as PageInfo["type"][]).map((k) => [k, cssVar(KIND_VAR[k])])) as Record<PageInfo["type"], string>;
    const accent = cssVar("--accent");
    const pad = cell >= 8 ? 1 : 0.5;
    for (let i = 0; i < n; i++) {
      const p = pages[i]!;
      const x = (i % cols) * cell, y = Math.floor(i / cols) * cell;
      ctx.fillStyle = colors[p.type];
      ctx.globalAlpha = p.type === "leaf" || p.type === "interior" ? 0.35 + 0.65 * Math.min(1, p.fill) : 1;
      ctx.fillRect(x + pad, y + pad, cell - 2 * pad, cell - 2 * pad);
      ctx.globalAlpha = 1;
      if (i === selected) { ctx.strokeStyle = accent; ctx.lineWidth = 2; ctx.strokeRect(x + 1, y + 1, cell - 2, cell - 2); }
    }
  }

  function pageAt(ev: MouseEvent): PageInfo | undefined {
    const r = canvas.getBoundingClientRect();
    const i = Math.floor((ev.clientY - r.top) / cell) * cols + Math.floor((ev.clientX - r.left) / cell);
    return pages[i];
  }

  canvas.addEventListener("mousemove", (ev) => {
    const p = pageAt(ev);
    if (!p) { tooltip.style.display = "none"; return; }
    tooltip.style.display = "block";
    tooltip.style.left = `${ev.clientX + 12}px`; tooltip.style.top = `${ev.clientY + 12}px`;
    tooltip.textContent = `page ${p.pageId}  ${p.type}${p.table ? `  ${p.table}` : ""}${p.cells !== undefined ? `  ${p.cells} cells` : ""}${p.fill ? `  ${Math.round(p.fill * 100)}% full` : ""}`;
  });
  canvas.addEventListener("mouseleave", () => { tooltip.style.display = "none"; });
  canvas.addEventListener("click", async (ev) => {
    const p = pageAt(ev);
    if (!p) return;
    selected = pages.indexOf(p);
    drawMap();
    await showPage(p.pageId);
  });

  async function showPage(id: number): Promise<void> {
    let d: WirePageDetail;
    try { d = await db.call("describePage", id); } catch (e) { pageDetail.replaceChildren(h("p", { style: { color: "var(--danger)" } }, (e as Error).message)); return; }
    const hd = d.header;
    const dl = h("dl", { class: "plan-detail" });
    const add = (k: string, v: unknown): void => { dl.append(h("dt", {}, k), h("dd", {}, String(v))); };
    add("page", d.pageId); add("type", `${d.type} (0x${hd.type.toString(16)})`);
    if (d.table) add("owner", d.table);
    add("cells", hd.cellCount); add("free start", hd.freeStart); add("free end", hd.freeEnd);
    add("right", hd.right); add("frag bytes", hd.fragBytes); add("live / usable", `${hd.liveBytes} / ${hd.usable} (${Math.round(100 * hd.liveBytes / Math.max(1, hd.usable))}%)`);
    const rows = d.cells.slice(0, 400).map((c) => h("tr", {},
      h("td", { class: "r" }, String(c.index)),
      h("td", {}, c.key.length > 40 ? c.key.slice(0, 39) + ".." : c.key),
      h("td", {}, c.child !== undefined ? `child ${c.child}` : c.overflowPage !== undefined ? `overflow ${c.overflowPage}` : (c.value ?? "").length > 50 ? (c.value ?? "").slice(0, 49) + ".." : (c.value ?? "")),
      h("td", { class: "r" }, `${c.keyBytes}${c.valueBytes !== undefined ? ` + ${c.valueBytes}` : ""}`),
    ));
    pageDetail.replaceChildren(
      h("div", { class: "plan-detail" }, dl),
      rows.length ? h("div", { class: "page-cells", style: { marginTop: "10px" } }, h("table", { class: "plain" }, h("thead", {}, h("tr", {}, h("th", { class: "r" }, "#"), h("th", {}, "key"), h("th", {}, "value / child"), h("th", { class: "r" }, "bytes"))), h("tbody", {}, ...rows))) : "",
      d.cells.length > 400 ? h("p", { class: "muted small" }, `showing 400 of ${d.cells.length} cells`) : "",
    );
  }

  let busy = false, again = false;
  async function refresh(): Promise<void> {
    if (busy) { again = true; return; }
    busy = true;
    try {
      const [map, trees, s] = await Promise.all([db.call("pageMap"), db.call("btreeStats"), db.call("stats")]);
      pages = map;
      const counts: Partial<Record<PageInfo["type"], number>> = {};
      for (const p of map) counts[p.type] = (counts[p.type] ?? 0) + 1;
      mapInfo.textContent = `${fmtInt(map.length)} pages x 4 KiB = ${fmtInt(map.length * 4)} KiB on ${db.backend}`;
      const hits = s.cacheHits, misses = s.cacheMisses;
      const ratio = hits + misses ? (100 * hits / (hits + misses)).toFixed(1) + "%" : "n/a";
      statsRow.replaceChildren(
        stat(fmtInt(s.pageCount), "pages in file"),
        stat(fmtInt(s.freePages), "free list pages"),
        stat(ratio, `cache hit ratio (${fmtInt(hits)} / ${fmtInt(hits + misses)})`),
        stat(String(s.txnId), "committed txn id"),
        stat(fmtInt(counts.leaf ?? 0), "leaf pages"),
        stat(fmtInt(counts.interior ?? 0), "interior pages"),
        stat(fmtInt(counts.overflow ?? 0), "overflow pages"),
      );
      treeBody.replaceChildren(...trees.map((t: TableTreeStats) => h("tr", {},
        h("td", {}, t.name, t.objectType === "index" ? h("span", { class: "muted" }, "  index") : ""),
        h("td", { class: "r" }, String(t.depth)),
        h("td", { class: "r" }, fmtInt(t.pages)),
        h("td", { class: "r" }, fmtInt(t.leafPages)),
        h("td", { class: "r" }, fmtInt(t.entries)),
        h("td", {}, h("span", { class: "fill" }, h("i", { style: { width: `${Math.round(t.fill * 100)}%` } })), `${Math.round(t.fill * 100)}%`),
      )));
      if (!trees.length) treeBody.replaceChildren(h("tr", {}, h("td", { colspan: 6, class: "muted" }, "No user tables yet. Load a dataset or create one in the notebook.")));
      drawMap();
    } catch (e) { console.error(e); }
    finally { busy = false; if (again) { again = false; refresh(); } }
  }

  const stat = (v: string, k: string): HTMLElement => h("div", { class: "stat" }, h("div", { class: "v" }, v), h("div", { class: "k" }, k));

  root.append(
    h("div", { class: "screen-head" }, h("h1", {}, "Storage"), h("p", {}, "Every 4 KiB page of notebook.basalt, live. Pages 0 and 1 are the double-buffered meta pages; data starts at page 2.")),
    h("div", { style: { marginBottom: "12px" } }, statsRow),
    h("div", { class: "storage-layout" },
      h("div", {},
        h("div", { class: "card", style: { marginBottom: "12px" } },
          h("div", { class: "card-head" }, "Page map", h("div", { class: "spacer" }), mapInfo),
          h("div", { class: "card-body" }, canvas, h("div", { style: { marginTop: "8px" } }, legend)),
        ),
        h("div", { class: "card" },
          h("div", { class: "card-head" }, "B+trees"),
          h("table", { class: "plain" }, h("thead", {}, h("tr", {}, h("th", {}, "object"), h("th", { class: "r" }, "depth"), h("th", { class: "r" }, "pages"), h("th", { class: "r" }, "leaves"), h("th", { class: "r" }, "entries"), h("th", {}, "leaf fill"))), treeBody),
        ),
      ),
      h("div", { class: "card" }, h("div", { class: "card-head" }, "Page"), pageDetail),
    ),
  );
  const off = db.onChange(() => refresh());
  const onResize = (): void => drawMap();
  window.addEventListener("resize", onResize);
  db.ready.then(refresh);
  return () => { off(); window.removeEventListener("resize", onResize); tooltip.remove(); };
}
