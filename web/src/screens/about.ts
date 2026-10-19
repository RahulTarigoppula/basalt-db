import { h } from "../ui.js";

const REPO = "https://github.com/RahulTarigoppula/basalt-db";

export function aboutScreen(root: HTMLElement): void {
  root.append(
    h("div", { class: "screen-head" }, h("h1", {}, "About Basalt")),
    h("div", { class: "prose" },
      h("p", {}, "Basalt is a relational database engine written from scratch in TypeScript with zero runtime dependencies. The same code runs in Node over a file and in the browser over the origin private file system (OPFS) inside a Web Worker. This site is the engine, not a demo of a different one: every query you run here is parsed, planned and executed in this tab."),
      h("h2", {}, "Architecture"),
      h("ul", {},
        h("li", {}, h("b", {}, "Storage: "), "4 KiB slotted pages, a pager with a CLOCK buffer pool, a copy-on-write B+tree with overflow pages, a free list tagged with the committing transaction id, and double-buffered meta pages. Commits are atomic without a write-ahead log: dirty pages are written, synced, then the other meta slot is written."),
        h("li", {}, h("b", {}, "Transactions: "), "snapshot isolation in the LMDB style. Readers take the committed root and never block; writers are serialised. Savepoints are copy-on-write epochs."),
        h("li", {}, h("b", {}, "SQL: "), "hand-written lexer and parser, a binder with type inference, and an expression compiler that turns bound expressions into closures once per plan."),
        h("li", {}, h("b", {}, "Planner: "), "rewrite rules (predicate pushdown, projection pruning, subquery to semi-join, top-k), a cost model fed by ANALYZE statistics, dynamic-programming join ordering up to 8 relations, and index selection including covering indexes."),
        h("li", {}, h("b", {}, "Executor: "), "Volcano iterators: sequential and index scans, nested-loop, hash and merge joins, hash and sorted aggregation, window functions, recursive CTEs, top-k and spilling sorts."),
        h("li", {}, h("b", {}, "Testing: "), "sqllogictest-style suites, B+tree and pager unit tests with crash simulation, and differential fuzzing against SQLite."),
      ),
      h("h2", {}, "Privacy"),
      h("p", {}, "Everything runs locally in your browser. The database file is stored in this origin's private file system (or IndexedDB when OPFS is unavailable) and nothing leaves your device: there is no server, no analytics and no network request after the page loads. Use Reset database on the Notebook screen to delete the file."),
      h("h2", {}, "Links"),
      h("ul", {},
        h("li", {}, h("a", { href: REPO, target: "_blank", rel: "noopener" }, "Source on GitHub")),
        h("li", {}, h("a", { href: `${REPO}/blob/main/docs/ARCHITECTURE.md`, target: "_blank", rel: "noopener" }, "docs/ARCHITECTURE.md: module contracts and file format")),
        h("li", {}, h("a", { href: `${REPO}/blob/main/docs/DESIGN-NOTES.md`, target: "_blank", rel: "noopener" }, "docs/DESIGN-NOTES.md: why copy-on-write instead of a WAL")),
        h("li", {}, h("a", { href: `${REPO}/blob/main/README.md`, target: "_blank", rel: "noopener" }, "README: usage, SQL support table, benchmarks")),
      ),
      h("p", { class: "muted small" }, "MIT licence. Built by Rahul Tarigoppula."),
    ),
  );
}
