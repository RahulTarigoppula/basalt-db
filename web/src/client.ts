/** Page-side proxy over the database worker plus a tiny event bus so screens can refresh after each statement. */
import type { BackendKind, MethodName, Methods, Request, Response, WireCell, WireError } from "./worker/protocol.js";

export class DbError extends Error {
  constructor(public readonly info: WireError) { super(info.message); this.name = info.name; }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

class Client {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private listeners = new Set<() => void>();
  backend: BackendKind = "memory";
  /** Why a better backend was not used (empty when OPFS opened). */
  openLog: string[] = [];
  ready: Promise<void>;

  constructor() {
    this.worker = new Worker(new URL("./worker/db.worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (ev: MessageEvent<Response>) => {
      const p = this.pending.get(ev.data.id);
      if (!p) return;
      this.pending.delete(ev.data.id);
      if (ev.data.ok) p.resolve(ev.data.result); else p.reject(new DbError(ev.data.error));
    };
    this.worker.onerror = (e) => {
      console.error("worker error", e.message ?? e);
      // A worker that failed to start never answers: fail every pending request instead of hanging the UI.
      for (const [id, p] of this.pending) { this.pending.delete(id); p.reject(new DbError({ name: "WorkerError", message: `database worker failed: ${e.message ?? "unknown error"}` })); }
    };
    // Release the OPFS sync access handle promptly so the next page load can take it.
    window.addEventListener("pagehide", () => this.worker.terminate());
    this.ready = this.send("open").then((r) => { this.backend = r.backend; this.openLog = r.log; if (r.log.length) console.warn("basalt backend fallback:", r.log.join("; ")); });
  }

  /** Sends one request. Everything except `open` itself waits for the database to be open first. */
  async call<M extends MethodName>(method: M, ...args: Methods[M]["args"]): Promise<Methods[M]["result"]> {
    if (method !== "open") await this.ready;
    return this.send(method, ...args);
  }

  private send<M extends MethodName>(method: M, ...args: Methods[M]["args"]): Promise<Methods[M]["result"]> {
    const id = this.nextId++;
    const req: Request<M> = { id, method, args };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.worker.postMessage(req);
    });
  }

  /** Runs SQL and notifies listeners (storage screen, header stats) that the file may have changed. */
  async exec(sql: string): Promise<Methods["exec"]["result"]> {
    try { return await this.call("exec", sql); } finally { this.changed(); }
  }

  changed(): void { for (const l of this.listeners) l(); }
  onChange(l: () => void): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
}

export const db = new Client();

/** Display text for a wire cell. */
export function cellText(c: WireCell): string {
  if (c === null) return "NULL";
  if (typeof c === "object") return c.t === "int" ? c.v : `x'${c.v}'`;
  if (typeof c === "number") return Number.isInteger(c) ? `${c}.0` : String(c);
  if (typeof c === "boolean") return c ? "1" : "0";
  return c;
}

export function isNumeric(c: WireCell): boolean {
  return typeof c === "number" || (typeof c === "object" && c !== null && c.t === "int");
}
