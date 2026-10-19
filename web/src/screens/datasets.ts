import { db } from "../client.js";
import { DATASETS } from "../catalog.js";
import { h, fmtMs, fmtInt, pendingCells, toast } from "../ui.js";

export function datasetsScreen(root: HTMLElement): void {
  const grid = h("div", { class: "dataset-grid" });
  root.append(
    h("div", { class: "screen-head" }, h("h1", {}, "Datasets"), h("p", {}, "Generated in the worker with a fixed seed, inserted with multi-row INSERT statements inside one transaction, then indexed and analysed.")),
    grid,
  );
  for (const d of DATASETS) {
    const status = h("span", { class: "muted small" }, "");
    const loadBtn = h("button", { class: "btn primary", onClick: async () => {
      loadBtn.disabled = true;
      status.textContent = "loading";
      try {
        const r = await db.call("loadDataset", d.id);
        db.changed();
        status.textContent = `${fmtInt(r.rows)} rows in ${fmtMs(r.ms)}`;
        toast(`${d.title}: ${fmtInt(r.rows)} rows loaded in ${fmtMs(r.ms)}`);
      } catch (e) { status.textContent = (e as Error).message; }
      finally { loadBtn.disabled = false; }
    } }, "Load");
    grid.appendChild(h("div", { class: "card" },
      h("div", { class: "card-head" }, h("h3", {}, d.title), h("div", { class: "spacer" }), status, loadBtn),
      h("div", { class: "card-body" },
        h("p", { class: "small", style: { color: "var(--ink-2)" } }, d.blurb),
        h("p", { class: "small muted mono" }, d.tables),
        h("ul", { class: "samples" }, ...d.samples.map((s) => h("li", {},
          h("span", {}, s.title),
          h("button", { class: "btn ghost", title: "Add as a notebook cell", onClick: () => { pendingCells.push(s.sql); location.hash = "#/notebook"; } }, "Notebook"),
          h("button", { class: "btn ghost", title: "Open in the plan visualiser", onClick: () => { localStorage.setItem("basalt.current", s.sql); location.hash = "#/plan"; } }, "Plan"),
        ))),
      ),
    ));
  }
}
