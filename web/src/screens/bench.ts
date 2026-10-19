import { db } from "../client.js";
import { BENCH_QUERIES } from "../catalog.js";
import { h, fmtMs, fmtInt, copyText } from "../ui.js";

interface BenchRow { name: string; sql: string; rows: number; runs: number[]; median: number; min: number }

function median(xs: number[]): number { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]!; }

export function benchScreen(root: HTMLElement): void {
  const canvas = h("canvas", { class: "bench-chart", height: 320 }) as HTMLCanvasElement;
  const tbody = h("tbody");
  const status = h("span", { class: "muted small" }, "");
  const runs = h("select", { class: "btn" }, h("option", { value: "3" }, "3 runs"), h("option", { value: "5", selected: true }, "5 runs"), h("option", { value: "10" }, "10 runs")) as HTMLSelectElement;
  let results: BenchRow[] = [];

  function draw(): void {
    const width = canvas.clientWidth || 800;
    const dpr = window.devicePixelRatio || 1;
    const height = Math.max(200, results.length * 26 + 20);
    canvas.width = width * dpr; canvas.height = height * dpr; canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(dpr, dpr);
    const css = getComputedStyle(document.documentElement);
    const ink = css.getPropertyValue("--ink").trim(), ink3 = css.getPropertyValue("--ink-3").trim(), accent = css.getPropertyValue("--accent").trim(), line = css.getPropertyValue("--line").trim();
    const labelW = 200, right = 70;
    const max = Math.max(1, ...results.map((r) => r.median));
    const scale = (width - labelW - right) / max;
    ctx.font = "11px Inter, system-ui, sans-serif";
    results.forEach((r, i) => {
      const y = 10 + i * 26;
      ctx.fillStyle = ink; ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText(r.name, labelW - 10, y + 9);
      ctx.fillStyle = line; ctx.fillRect(labelW, y, width - labelW - right, 18);
      ctx.fillStyle = accent; ctx.fillRect(labelW, y, Math.max(2, r.median * scale), 18);
      ctx.fillStyle = ink3; ctx.textAlign = "left";
      ctx.font = "11px 'JetBrains Mono', monospace";
      ctx.fillText(fmtMs(r.median), labelW + Math.max(2, r.median * scale) + 6, y + 9);
      ctx.font = "11px Inter, system-ui, sans-serif";
    });
  }

  function table(): void {
    tbody.replaceChildren(...results.map((r) => h("tr", {},
      h("td", {}, r.name),
      h("td", { class: "r" }, fmtInt(r.rows)),
      h("td", { class: "r" }, fmtMs(r.median)),
      h("td", { class: "r" }, fmtMs(r.min)),
      h("td", { class: "muted", style: { fontSize: "11px", maxWidth: "380px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: r.sql }, r.sql),
    )));
  }

  function markdown(): string {
    const ua = navigator.userAgent.match(/(Chrome|Firefox|Safari|Edg)\/[\d.]+/)?.[0] ?? "browser";
    const lines = [`| query | rows | median ms | min ms |`, `|---|---:|---:|---:|`];
    for (const r of results) lines.push(`| ${r.name} | ${r.rows} | ${r.median.toFixed(2)} | ${r.min.toFixed(2)} |`);
    lines.push("", `${runs.value} runs each, median reported. ${ua} on ${db.backend}, ${new Date().toISOString().slice(0, 10)}.`);
    return lines.join("\n");
  }

  async function run(): Promise<void> {
    runBtn.disabled = true;
    results = [];
    try {
      const s = await db.call("stats");
      if (!s.tables.includes("orders_50k")) { status.textContent = "loading orders_50k"; await db.call("loadDataset", "orders_50k"); }
      if (!s.tables.includes("lineitem")) { status.textContent = "loading tpch_mini"; await db.call("loadDataset", "tpch_mini"); }
      db.changed();
      const n = Number(runs.value);
      for (const q of BENCH_QUERIES) {
        status.textContent = `running ${q.name}`;
        const times: number[] = [];
        let rows = 0;
        await db.call("query", q.sql); // warm the cache and the plan cache
        for (let i = 0; i < n; i++) { const r = await db.call("query", q.sql); times.push(r.ms); rows = r.rows.length; }
        results.push({ name: q.name, sql: q.sql, rows, runs: times, median: median(times), min: Math.min(...times) });
        table(); draw();
      }
      status.textContent = `done: ${results.length} queries, total median ${fmtMs(results.reduce((a, r) => a + r.median, 0))}`;
    } catch (e) { status.textContent = (e as Error).message; }
    finally { runBtn.disabled = false; }
  }

  const runBtn = h("button", { class: "btn primary", onClick: run }, "Run benchmark");
  root.append(
    h("div", { class: "screen-head" }, h("h1", {}, "Bench"), h("p", {}, "A fixed query set over TPC-H mini and the 50k orders table, timed inside the worker (engine time only, no message overhead)."),
      h("div", { class: "spacer" }), status, runs, h("button", { class: "btn", onClick: () => { if (results.length) copyText(markdown()); } }, "Copy as markdown"), runBtn),
    h("div", { class: "card", style: { marginBottom: "12px" } }, h("div", { class: "card-head" }, "Median time per query"), h("div", { class: "card-body" }, canvas)),
    h("div", { class: "card" }, h("table", { class: "plain bench-table" }, h("thead", {}, h("tr", {}, h("th", {}, "query"), h("th", { class: "r" }, "rows"), h("th", { class: "r" }, "median"), h("th", { class: "r" }, "min"), h("th", {}, "sql"))), tbody)),
  );
  draw();
}
