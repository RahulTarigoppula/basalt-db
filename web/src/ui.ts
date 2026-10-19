/** Tiny DOM helpers shared by every screen. No framework: elements are built directly. */

type Child = Node | string | null | undefined | false | Child[];

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k in el && typeof v !== "string") (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
}

export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...children: (Node | string)[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of children) el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  return el;
}

let toastTimer = 0;
export function toast(msg: string): void {
  let el = document.querySelector<HTMLElement>(".toast");
  if (!el) { el = h("div", { class: "toast" }); document.body.appendChild(el); }
  el.textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el?.remove(), 2200);
}

export const fmtMs = (ms: number): string => (ms < 10 ? ms.toFixed(2) : ms < 100 ? ms.toFixed(1) : Math.round(ms).toString()) + " ms";
export const fmtInt = (n: number | bigint): string => n.toLocaleString("en-US");

/** The query the Plan screen analyses: the last cell run in the notebook. */
export const currentQuery = {
  get(): string { try { return localStorage.getItem("basalt.current") ?? ""; } catch { return ""; } },
  set(sql: string): void { try { localStorage.setItem("basalt.current", sql); } catch { /* private mode */ } },
};

/** Queue of SQL snippets to insert into the notebook (set by Datasets, consumed by Notebook). */
export const pendingCells = {
  push(sql: string): void {
    const cur = this.take();
    cur.push(sql);
    try { sessionStorage.setItem("basalt.pending", JSON.stringify(cur)); } catch { /* ignore */ }
  },
  take(): string[] {
    try {
      const v = sessionStorage.getItem("basalt.pending");
      sessionStorage.removeItem("basalt.pending");
      return v ? (JSON.parse(v) as string[]) : [];
    } catch { return []; }
  },
};

export async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); toast("Copied to clipboard"); }
  catch { toast("Clipboard unavailable"); }
}
