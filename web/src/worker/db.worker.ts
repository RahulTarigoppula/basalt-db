/**
 * Database worker: owns the one `Database` handle of the page. Opens OPFS when the worker has a sync access handle,
 * falls back to IndexedDB, then to memory. See `protocol.ts` for the message shapes.
 */
import { Database, formatValue, formatPlan, IndexedDbBackend, OpfsBackend, type Value, type Row, type QueryResult, type Backend } from "../../../src/index.js";
import type { BackendKind, DatasetName, MethodName, Methods, Request, Response, WireCell, WireError, WireResult } from "./protocol.js";
import { loadDataset } from "./datasets.js";

const FILE = "notebook.basalt";
let db: Database | null = null;
let backendKind: BackendKind = "memory";

function hex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}

function wireCell(v: Value): WireCell {
  if (typeof v === "bigint") return { t: "int", v: v.toString() };
  if (v instanceof Uint8Array) return { t: "blob", v: hex(v) };
  return v;
}

function wireRows(rows: Row[]): WireCell[][] {
  const out = new Array<WireCell[]>(rows.length);
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const w = new Array<WireCell>(r.length);
    for (let j = 0; j < r.length; j++) w[j] = wireCell(r[j]!);
    out[i] = w;
  }
  return out;
}

function wireResult(r: QueryResult, ms: number): WireResult {
  const out: WireResult = { columns: r.columns, rows: wireRows(r.rows), rowsAffected: r.rowsAffected, ms };
  if (r.lastRowid !== undefined) out.lastRowid = r.lastRowid.toString();
  return out;
}

function toError(e: unknown): WireError {
  if (e instanceof Error) {
    const err: WireError = { name: e.name, message: e.message };
    const anyE = e as { line?: number; col?: number };
    if (typeof anyE.line === "number") err.line = anyE.line;
    if (typeof anyE.col === "number") err.col = anyE.col;
    return err;
  }
  return { name: "Error", message: String(e) };
}

const openLog: string[] = [];
async function openDb(): Promise<{ backend: BackendKind; name: string; log: string[] }> {
  if (db) return { backend: backendKind, name: FILE, log: openLog };
  const hasOpfs = typeof navigator !== "undefined" && !!navigator.storage?.getDirectory && typeof FileSystemFileHandle !== "undefined" && "createSyncAccessHandle" in FileSystemFileHandle.prototype;
  if (hasOpfs) {
    // A previous page's worker may still hold the sync access handle for a moment after a reload: retry briefly.
    for (let attempt = 0; attempt < 8; attempt++) {
      try { db = await Database.open({ opfs: FILE }); backendKind = "opfs"; return { backend: backendKind, name: FILE, log: openLog }; }
      catch (e) {
        const err = e as Error;
        if (attempt === 7 || err.name !== "NoModificationAllowedError") { openLog.push(`OPFS: ${err.name}: ${err.message}`); console.warn("OPFS open failed, falling back", e); break; }
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  } else openLog.push("OPFS: no createSyncAccessHandle in this worker");
  if (typeof indexedDB !== "undefined") {
    try { const b = await IndexedDbBackend.open(FILE); db = await Database.open({ backend: b }); backendKind = "indexeddb"; return { backend: backendKind, name: FILE, log: openLog }; }
    catch (e) { openLog.push(`IndexedDB: ${(e as Error).name}: ${(e as Error).message}`); console.warn("IndexedDB open failed, falling back", e); }
  }
  db = await Database.open({ memory: true });
  backendKind = "memory";
  return { backend: backendKind, name: FILE, log: openLog };
}

function need(): Database {
  if (!db) throw new Error("database is not open (the open request failed; reload the page)");
  return db;
}

function exportBytes(backend: Backend): Uint8Array {
  const n = backend.pageCount();
  const out = new Uint8Array(n * backend.pageSize);
  const page = new Uint8Array(backend.pageSize);
  for (let i = 0; i < n; i++) { backend.readSync(i, page); out.set(page, i * backend.pageSize); }
  return out;
}

const handlers: { [M in MethodName]: (...args: Methods[M]["args"]) => Promise<Methods[M]["result"]> | Methods[M]["result"] } = {
  open: () => openDb(),
  exec: (sql) => {
    const d = need();
    // Run statement by statement so each result carries its own timing.
    const out: WireResult[] = [];
    const t0 = performance.now();
    const results = d.exec(sql);
    const total = performance.now() - t0;
    for (const r of results) out.push(wireResult(r, results.length === 1 ? total : total / results.length));
    return out;
  },
  query: (sql) => {
    const d = need();
    const t0 = performance.now();
    const r = d.query(sql);
    return wireResult(r, performance.now() - t0);
  },
  explain: (sql, analyze) => {
    const d = need();
    const t0 = performance.now();
    const plan = d.explain(sql, analyze);
    return { plan, text: formatPlan(plan), ms: performance.now() - t0 };
  },
  pageMap: () => need().pageMap(),
  describePage: (pageId) => {
    const detail = need().describePage(pageId);
    return {
      ...detail,
      cells: detail.cells.map((c) => {
        const o: Methods["describePage"]["result"]["cells"][number] = { index: c.index, key: c.key.map(formatValue).join(", "), keyBytes: c.keyBytes };
        if (c.child !== undefined) o.child = c.child;
        if (c.value !== undefined) o.value = typeof c.value === "string" ? c.value : c.value.map(formatValue).join(", ");
        if (c.valueBytes !== undefined) o.valueBytes = c.valueBytes;
        if (c.overflowPage !== undefined) o.overflowPage = c.overflowPage;
        return o;
      }),
    };
  },
  btreeStats: () => {
    const d = need();
    const out: Methods["btreeStats"]["result"] = [];
    for (const t of d.tables()) {
      try { out.push({ name: t, objectType: "table", ...d.btreeStats(t) }); } catch { /* dropped between calls */ }
      const idx = d.query(`PRAGMA index_list(${t})`);
      const nameCol = idx.columns.findIndex((c) => c.name === "name");
      for (const r of idx.rows) {
        const name = String(r[nameCol >= 0 ? nameCol : 1]);
        try { out.push({ name, objectType: "index", ...d.btreeStats(name) }); } catch { /* autoindex without a tree */ }
      }
    }
    return out;
  },
  stats: () => { const d = need(); return { ...d.stats(), tables: d.tables() }; },
  loadDataset: (name: DatasetName) => loadDataset(need(), name),
  export: () => exportBytes(need().backend),
  reset: async () => {
    if (db) { await db.close(); db = null; }
    try {
      if (backendKind === "opfs") await OpfsBackend.remove(FILE);
      else if (backendKind === "indexeddb") await IndexedDbBackend.remove(FILE);
    } catch (e) { openLog.push(`remove: ${(e as Error).name}: ${(e as Error).message}`); console.warn("remove failed", e); }
    const r = await openDb();
    return { backend: r.backend };
  },
};

// Requests are served strictly in order: the page's first request is always `open`, so a query posted before the
// database finished opening waits for it instead of failing with "database is not open". The engine is synchronous,
// so serialising here costs nothing and also keeps `reset` (which closes and reopens) from interleaving with a query.
let chain: Promise<void> = Promise.resolve();
self.onmessage = (ev: MessageEvent<Request>) => {
  const req = ev.data;
  chain = chain.then(async () => {
    let res: Response;
    try {
      const fn = handlers[req.method] as (...a: unknown[]) => unknown;
      const result = await fn(...(req.args as unknown[]));
      res = { id: req.id, ok: true, result: result as never };
      if (result instanceof Uint8Array) { (self as unknown as Worker).postMessage(res, [result.buffer]); return; }
    } catch (e) {
      res = { id: req.id, ok: false, error: toError(e) };
    }
    (self as unknown as Worker).postMessage(res);
  });
};
