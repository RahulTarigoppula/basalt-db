/**
 * Basalt REPL (Node only). `npm run cli -- [file.basalt]`
 *
 * Dot commands: .tables, .schema [table], .indexes [table], .explain on|off, .timer on|off, .import file.csv table,
 * .open file, .dump, .stats, .quit. SQL statements end with `;` and may span lines. Results are drawn as box tables.
 */
import { createInterface } from "node:readline";
import { readFileSync } from "node:fs";
import { Database } from "../engine/database.js";
import { formatValue } from "../engine/result.js";
import type { QueryResult } from "../core/types.js";
import type { Value } from "../core/types.js";

let db: Database;
let explain = false;
let timer = false;

function box(result: QueryResult): string {
  if (result.columns.length === 0) return "";
  const header = result.columns.map((c) => c.name);
  const cells = result.rows.map((r) => r.map((v) => formatValue(v)));
  const widths = header.map((h, i) => Math.max(h.length, ...cells.map((r) => r[i]!.length)));
  const line = (l: string, m: string, r: string): string => l + widths.map((w) => "-".repeat(w + 2)).join(m) + r;
  const row = (vals: string[]): string => "|" + vals.map((v, i) => ` ${v.padEnd(widths[i]!)} `).join("|") + "|";
  const out = [line("+", "+", "+"), row(header), line("+", "+", "+")];
  for (const c of cells) out.push(row(c));
  out.push(line("+", "+", "+"));
  return out.join("\n");
}

function print(s: string): void { process.stdout.write(s + "\n"); }

function runSql(sql: string): void {
  const t0 = performance.now();
  try {
    const results = db.exec(explain && /^\s*(select|with|insert|update|delete)/i.test(sql) ? `EXPLAIN ${sql}` : sql);
    for (const r of results) {
      if (r.columns.length) { print(box(r)); print(`${r.rows.length} row${r.rows.length === 1 ? "" : "s"}`); }
      else if (r.rowsAffected) print(`${r.rowsAffected} row${r.rowsAffected === 1 ? "" : "s"} affected`);
    }
  } catch (e) {
    print(`Error: ${(e as Error).message}`);
  }
  if (timer) print(`(${(performance.now() - t0).toFixed(1)} ms)`);
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQ) {
      if (c === "\"") { if (line[i + 1] === "\"") { cur += "\""; i++; } else inQ = false; }
      else cur += c;
    } else if (c === "\"") inQ = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function csvValue(s: string): Value {
  if (s === "") return null;
  if (/^-?\d+$/.test(s)) { try { return BigInt(s); } catch { return s; } }
  if (/^-?\d*\.\d+(e[+-]?\d+)?$/i.test(s) || /^-?\d+e[+-]?\d+$/i.test(s)) return Number(s);
  return s;
}

async function dot(cmd: string): Promise<boolean> {
  const [name, ...args] = cmd.trim().split(/\s+/);
  switch (name) {
    case ".quit": case ".exit": return false;
    case ".tables": print(db.tables().join("  ")); break;
    case ".schema": for (const s of db.schemaSql(args[0])) print(s + ";"); break;
    case ".indexes": {
      const r = args[0] ? db.query("PRAGMA index_list(" + JSON.stringify(args[0]) + ")") : db.query("SELECT name, tbl_name FROM basalt_master WHERE type = 'index'");
      print(box(r));
      break;
    }
    case ".explain": explain = args[0] !== "off"; print(`explain ${explain ? "on" : "off"}`); break;
    case ".timer": timer = args[0] !== "off"; print(`timer ${timer ? "on" : "off"}`); break;
    case ".stats": print(JSON.stringify(db.stats())); break;
    case ".open": {
      if (!args[0]) { print("usage: .open file"); break; }
      await db.close();
      db = await Database.open({ file: args[0] });
      print(`opened ${args[0]}`);
      break;
    }
    case ".import": {
      const [file, table] = args;
      if (!file || !table) { print("usage: .import file.csv table"); break; }
      const lines = readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.length > 0);
      if (lines.length === 0) break;
      const header = parseCsvLine(lines[0]!);
      const exists = db.tables().some((t) => t.toLowerCase() === table.toLowerCase());
      if (!exists) db.exec(`CREATE TABLE "${table}"(${header.map((h) => `"${h}"`).join(", ")})`);
      const stmt = db.prepare(`INSERT INTO "${table}" VALUES (${header.map(() => "?").join(", ")})`);
      db.transaction(() => { for (let i = 1; i < lines.length; i++) stmt.run(parseCsvLine(lines[i]!).map(csvValue)); });
      print(`imported ${lines.length - 1} rows into ${table}`);
      break;
    }
    case ".dump": {
      for (const s of db.schemaSql()) print(s + ";");
      for (const t of db.tables()) {
        const r = db.query(`SELECT * FROM "${t}"`);
        for (const row of r.rows) print(`INSERT INTO "${t}" VALUES (${row.map((v) => (typeof v === "string" ? `'${v.replace(/'/g, "''")}'` : formatValue(v))).join(", ")});`);
      }
      break;
    }
    case ".help": print(".tables .schema [t] .indexes [t] .explain on|off .timer on|off .import file.csv table .open file .dump .stats .quit"); break;
    default: print(`unknown command: ${name}`);
  }
  return true;
}

async function main(): Promise<void> {
  const file = process.argv[2];
  db = file ? await Database.open({ file }) : await Database.open({ memory: true });
  print(`Basalt ${file ? `(${file})` : "(in-memory)"}; type .help for commands, SQL statements end with ';'`);
  const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "basalt> " });
  let buffer = "";
  rl.prompt();
  rl.on("line", (line) => {
    void (async () => {
      if (buffer === "" && line.trim().startsWith(".")) {
        if (!(await dot(line))) { rl.close(); return; }
        rl.prompt();
        return;
      }
      buffer += (buffer ? "\n" : "") + line;
      if (/;\s*$/.test(buffer)) { const sql = buffer; buffer = ""; runSql(sql); rl.setPrompt("basalt> "); }
      else rl.setPrompt("   ...> ");
      rl.prompt();
    })();
  });
  rl.on("close", () => { void db.close().then(() => process.exit(0)); });
}

void main();
