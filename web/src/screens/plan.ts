import { db, DbError } from "../client.js";
import type { PlanNode } from "../../../src/index.js";
import { h, svg, fmtMs, currentQuery, fmtInt } from "../ui.js";

const NODE_W = 170, NODE_H = 46, GAP_X = 16, GAP_Y = 34;

interface Laid { node: PlanNode; x: number; y: number; children: Laid[] }

function layout(node: PlanNode, depth: number, cursor: { x: number }): Laid {
  const kids = node.children.map((c) => layout(c, depth + 1, cursor));
  let x: number;
  if (kids.length === 0) { x = cursor.x; cursor.x += NODE_W + GAP_X; }
  else x = (kids[0]!.x + kids[kids.length - 1]!.x) / 2;
  return { node, x, y: depth * (NODE_H + GAP_Y), children: kids };
}

function heat(frac: number): string {
  // paper -> amber -> rust, by share of total time.
  const f = Math.max(0, Math.min(1, frac));
  if (f < 0.5) { const t = f / 0.5; return `rgba(232, 179, 106, ${0.08 + t * 0.55})`; }
  const t = (f - 0.5) / 0.5;
  return `rgba(${Math.round(232 + (180 - 232) * t)}, ${Math.round(179 + (69 - 179) * t)}, ${Math.round(106 + (47 - 106) * t)}, ${0.63 + t * 0.3})`;
}

function summary(n: PlanNode): string {
  const p = n.props;
  const first = p["table"] ?? p["index"] ?? p["condition"] ?? p["filter"] ?? p["keys"] ?? p["groupBy"] ?? p["limit"] ?? "";
  return String(first ?? "").slice(0, 26);
}

export function planScreen(root: HTMLElement): void {
  const ta = h("textarea", { spellcheck: false, rows: 4, style: { width: "100%", border: "0", background: "transparent", color: "var(--ink)", padding: "10px 12px", resize: "vertical", outline: "0", display: "block" } }) as HTMLTextAreaElement;
  ta.value = currentQuery.get() || "SELECT 1";
  const analyze = h("input", { type: "checkbox", checked: true }) as HTMLInputElement;
  const svgWrap = h("div", { class: "plan-svg-wrap card-body" });
  const detail = h("div", { class: "plan-detail card-body" }, h("p", { class: "muted" }, "Hover or click an operator to see its properties."));
  const text = h("pre", { class: "plan-text mono" }, "");
  const status = h("span", { class: "muted small" }, "");

  const run = async (): Promise<void> => {
    const sql = ta.value.trim();
    if (!sql) return;
    currentQuery.set(sql);
    status.textContent = "planning";
    try {
      const r = await db.call("explain", sql, analyze.checked);
      db.changed();
      draw(r.plan);
      text.textContent = r.text.join("\n");
      status.textContent = `${analyze.checked ? "EXPLAIN ANALYZE" : "EXPLAIN"} in ${fmtMs(r.ms)}`;
    } catch (e) {
      const info = e instanceof DbError ? e.info : { name: "Error", message: String(e) };
      svgWrap.replaceChildren(h("p", { class: "err mono", style: { color: "var(--danger)" } }, `${info.name}: ${info.message}${info.line !== undefined ? ` (line ${info.line}:${info.col ?? 1})` : ""}`));
      text.textContent = "";
      status.textContent = "";
    }
  };

  function showDetail(n: PlanNode): void {
    const dl = h("dl");
    const add = (k: string, v: unknown): void => { dl.append(h("dt", {}, k), h("dd", {}, String(v))); };
    add("operator", n.op);
    add("estimated rows", fmtInt(n.estRows));
    add("estimated cost", n.estCost.toFixed(1));
    if (n.actualRows !== undefined) { add("actual rows", fmtInt(n.actualRows)); add("loops", n.loops ?? 1); add("time", fmtMs(n.ms ?? 0)); }
    for (const [k, v] of Object.entries(n.props)) add(k, v);
    detail.replaceChildren(h("h3", {}, n.op), dl);
  }

  function draw(plan: PlanNode): void {
    const laid = layout(plan, 0, { x: 0 });
    let maxX = 0, maxY = 0;
    const all: Laid[] = [];
    const walk = (l: Laid): void => { all.push(l); maxX = Math.max(maxX, l.x + NODE_W); maxY = Math.max(maxY, l.y + NODE_H); l.children.forEach(walk); };
    walk(laid);
    const total = Math.max(plan.ms ?? 0, 0.0001);
    const el = svg("svg", { class: "plan-svg", width: maxX + 2, height: maxY + 2, viewBox: `-1 -1 ${maxX + 2} ${maxY + 2}` });
    for (const l of all) for (const c of l.children) {
      el.appendChild(svg("path", { class: "edge", d: `M ${l.x + NODE_W / 2} ${l.y + NODE_H} C ${l.x + NODE_W / 2} ${l.y + NODE_H + GAP_Y / 2}, ${c.x + NODE_W / 2} ${c.y - GAP_Y / 2}, ${c.x + NODE_W / 2} ${c.y}` }));
    }
    for (const l of all) {
      const n = l.node;
      const g = svg("g", { class: "node", transform: `translate(${l.x},${l.y})` });
      const own = n.ms !== undefined ? n.ms - n.children.reduce((a, c) => a + (c.ms ?? 0), 0) : 0;
      g.appendChild(svg("rect", { width: NODE_W, height: NODE_H, fill: n.ms !== undefined ? heat(own / total) : "var(--paper-2)" }));
      g.appendChild(svg("text", { class: "op", x: 8, y: 16 }, n.op));
      const rows = n.actualRows !== undefined ? `est ${fmtInt(n.estRows)}  act ${fmtInt(n.actualRows)}` : `est ${fmtInt(n.estRows)} rows`;
      g.appendChild(svg("text", { class: "rows", x: 8, y: 30 }, rows));
      const extra = n.ms !== undefined ? `${fmtMs(n.ms)}` : summary(n);
      g.appendChild(svg("text", { class: "rows", x: 8, y: 42 }, extra.length > 24 ? extra.slice(0, 23) + ".." : extra));
      g.appendChild(svg("title", {}, `${n.op}\n${Object.entries(n.props).map(([k, v]) => `${k}: ${v}`).join("\n")}`));
      g.addEventListener("mouseenter", () => showDetail(n));
      g.addEventListener("click", () => showDetail(n));
      el.appendChild(g);
    }
    svgWrap.replaceChildren(el);
    showDetail(plan);
  }

  ta.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); run(); } });

  root.append(
    h("div", { class: "screen-head" }, h("h1", {}, "Plan"), h("p", {}, "The physical plan the cost-based planner chose, with estimated versus actual rows and time per operator.")),
    h("div", { class: "card", style: { marginBottom: "12px" } },
      ta,
      h("div", { class: "cell-meta" },
        h("label", { style: { display: "flex", gap: "5px", alignItems: "center" } }, analyze, "ANALYZE (execute and measure)"),
        status,
        h("div", { class: "cell-actions" }, h("button", { class: "btn", onClick: () => { currentQuery.set(ta.value); location.hash = "#/notebook"; } }, "Open in notebook"), h("button", { class: "btn primary", onClick: run }, "Explain")),
      ),
    ),
    h("div", { class: "plan-layout" },
      h("div", { class: "card" },
        h("div", { class: "card-head" }, "Operator tree", h("div", { class: "spacer" }), h("span", { class: "heat-legend" }, "time share", h("i", { class: "bar" }))),
        svgWrap,
        h("div", { class: "card-head" }, "Text plan"),
        text,
      ),
      h("div", { class: "card" }, h("div", { class: "card-head" }, "Operator"), detail),
    ),
  );
  run();
}
