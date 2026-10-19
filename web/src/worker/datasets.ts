/**
 * Bundled datasets, generated deterministically inside the worker (seeded PRNG, no network). Each loader drops and
 * recreates its tables so it can be re-run.
 */
import type { Database } from "../../../src/index.js";
import type { DatasetName } from "./protocol.js";

/** mulberry32: small, fast, deterministic. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Lit = bigint | number | string | null;
const lit = (v: Lit): string => v === null ? "NULL" : typeof v === "string" ? `'${v.replace(/'/g, "''")}'` : typeof v === "number" ? (Number.isInteger(v) ? `${v}.0` : String(v)) : v.toString();

/**
 * Multi-row INSERT batches. One statement per 500 rows keeps the per-statement copy-on-write overhead low: a
 * prepared statement per row inside one transaction allocates fresh pages for every row's pre-image chain.
 */
class Inserter {
  private rows: string[] = [];
  constructor(private readonly db: Database, private readonly table: string, private readonly batch = 500) {}
  run(values: Lit[]): void { this.rows.push(`(${values.map(lit).join(",")})`); if (this.rows.length >= this.batch) this.flush(); }
  flush(): void { if (this.rows.length) { this.db.exec(`INSERT INTO ${this.table} VALUES ${this.rows.join(",")}`); this.rows = []; } }
}

const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const int = (r: () => number, lo: number, hi: number): bigint => BigInt(lo + Math.floor(r() * (hi - lo + 1)));
const day = (r: () => number, startYear: number, years: number): string => {
  const d = new Date(Date.UTC(startYear, 0, 1) + Math.floor(r() * years * 365) * 86400000);
  return d.toISOString().slice(0, 10);
};

const SEGMENTS = ["BUILDING", "AUTOMOBILE", "MACHINERY", "HOUSEHOLD", "FURNITURE"] as const;
const PRIORITIES = ["1-URGENT", "2-HIGH", "3-MEDIUM", "4-NOT SPECIFIED", "5-LOW"] as const;
const NATIONS = ["ALGERIA", "ARGENTINA", "BRAZIL", "CANADA", "EGYPT", "ETHIOPIA", "FRANCE", "GERMANY", "INDIA", "INDONESIA", "IRAN", "IRAQ", "JAPAN", "JORDAN", "KENYA", "MOROCCO", "MOZAMBIQUE", "PERU", "CHINA", "ROMANIA", "SAUDI ARABIA", "VIETNAM", "RUSSIA", "UNITED KINGDOM", "UNITED STATES"] as const;

function tpchMini(db: Database): { rows: number; tables: string[] } {
  const r = rng(7);
  db.exec(`
    DROP TABLE IF EXISTS lineitem; DROP TABLE IF EXISTS orders; DROP TABLE IF EXISTS customer; DROP TABLE IF EXISTS nation;
    CREATE TABLE nation (n_nationkey INTEGER PRIMARY KEY, n_name TEXT NOT NULL, n_regionkey INTEGER NOT NULL);
    CREATE TABLE customer (c_custkey INTEGER PRIMARY KEY, c_name TEXT NOT NULL, c_nationkey INTEGER NOT NULL, c_acctbal REAL NOT NULL, c_mktsegment TEXT NOT NULL);
    CREATE TABLE orders (o_orderkey INTEGER PRIMARY KEY, o_custkey INTEGER NOT NULL, o_orderstatus TEXT NOT NULL, o_totalprice REAL NOT NULL, o_orderdate TEXT NOT NULL, o_orderpriority TEXT NOT NULL);
    CREATE TABLE lineitem (l_orderkey INTEGER NOT NULL, l_linenumber INTEGER NOT NULL, l_partkey INTEGER NOT NULL, l_quantity INTEGER NOT NULL, l_extendedprice REAL NOT NULL, l_discount REAL NOT NULL, l_returnflag TEXT NOT NULL, l_shipdate TEXT NOT NULL, PRIMARY KEY (l_orderkey, l_linenumber));
  `);
  let rows = 0;
  db.exec("BEGIN");
  try {
    const nation = new Inserter(db, "nation");
    NATIONS.forEach((n, i) => { nation.run([BigInt(i), n, BigInt(i % 5)]); rows++; });
    const cust = new Inserter(db, "customer");
    const N_CUST = 1500, N_ORD = 7500, LINES_MAX = 5;
    for (let i = 1; i <= N_CUST; i++) { cust.run([BigInt(i), `Customer#${String(i).padStart(9, "0")}`, int(r, 0, NATIONS.length - 1), Math.round((r() * 10999 - 999) * 100) / 100, pick(r, SEGMENTS)]); rows++; }
    const ord = new Inserter(db, "orders");
    const line = new Inserter(db, "lineitem");
    for (let o = 1; o <= N_ORD; o++) {
      const nLines = 1 + Math.floor(r() * LINES_MAX);
      let total = 0;
      const date = day(r, 1995, 4);
      const lines: Lit[][] = [];
      for (let l = 1; l <= nLines; l++) {
        const qty = int(r, 1, 50);
        const price = Math.round(Number(qty) * (900 + r() * 1100) * 100) / 100;
        const disc = Math.round(r() * 10) / 100;
        total += price * (1 - disc);
        lines.push([BigInt(o), BigInt(l), int(r, 1, 2000), qty, price, disc, pick(r, ["N", "N", "R", "A"]), date]);
      }
      ord.run([BigInt(o), int(r, 1, N_CUST), pick(r, ["O", "F", "P"]), Math.round(total * 100) / 100, date, pick(r, PRIORITIES)]);
      rows++;
      for (const l of lines) { line.run(l); rows++; }
    }
    nation.flush(); cust.flush(); ord.flush(); line.flush();
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  db.exec("CREATE INDEX idx_orders_cust ON orders(o_custkey); CREATE INDEX idx_orders_date ON orders(o_orderdate); CREATE INDEX idx_customer_nation ON customer(c_nationkey); ANALYZE");
  return { rows, tables: ["nation", "customer", "orders", "lineitem"] };
}

function orders50k(db: Database): { rows: number; tables: string[] } {
  const r = rng(50);
  db.exec(`
    DROP TABLE IF EXISTS orders_50k;
    CREATE TABLE orders_50k (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL, region TEXT NOT NULL, status TEXT NOT NULL, amount REAL NOT NULL, created_day INTEGER NOT NULL, note TEXT);
  `);
  const regions = ["north", "south", "east", "west", "central"];
  const statuses = ["new", "paid", "shipped", "delivered", "cancelled"];
  db.exec("BEGIN");
  try {
    const ins = new Inserter(db, "orders_50k");
    for (let i = 1; i <= 50000; i++) {
      ins.run([BigInt(i), int(r, 1, 5000), pick(r, regions), pick(r, statuses), Math.round(r() * r() * 50000) / 100, int(r, 0, 729), r() < 0.1 ? `gift wrap, ref ${Math.floor(r() * 1e6)}` : null]);
    }
    ins.flush();
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  db.exec("CREATE INDEX idx_o50_customer ON orders_50k(customer_id); CREATE INDEX idx_o50_day ON orders_50k(created_day); ANALYZE");
  return { rows: 50000, tables: ["orders_50k"] };
}

const COUNTRIES: [code: string, name: string, continent: string, region: string, population: number, gdpUsdBn: number][] = [
  ["ARG", "Argentina", "South America", "Southern Cone", 46000000, 640], ["AUS", "Australia", "Oceania", "Australia and New Zealand", 26000000, 1700],
  ["BRA", "Brazil", "South America", "Eastern South America", 215000000, 2100], ["CAN", "Canada", "North America", "Northern America", 40000000, 2100],
  ["CHN", "China", "Asia", "Eastern Asia", 1410000000, 17900], ["DEU", "Germany", "Europe", "Western Europe", 84000000, 4400],
  ["EGY", "Egypt", "Africa", "Northern Africa", 110000000, 400], ["ESP", "Spain", "Europe", "Southern Europe", 48000000, 1500],
  ["ETH", "Ethiopia", "Africa", "Eastern Africa", 125000000, 150], ["FRA", "France", "Europe", "Western Europe", 68000000, 3000],
  ["GBR", "United Kingdom", "Europe", "British Isles", 67000000, 3300], ["IDN", "Indonesia", "Asia", "Southeast Asia", 277000000, 1400],
  ["IND", "India", "Asia", "Southern Asia", 1420000000, 3700], ["IRN", "Iran", "Asia", "Middle East", 88000000, 400],
  ["ITA", "Italy", "Europe", "Southern Europe", 59000000, 2200], ["JPN", "Japan", "Asia", "Eastern Asia", 124000000, 4200],
  ["KEN", "Kenya", "Africa", "Eastern Africa", 55000000, 110], ["KOR", "South Korea", "Asia", "Eastern Asia", 52000000, 1700],
  ["MEX", "Mexico", "North America", "Central America", 128000000, 1800], ["NGA", "Nigeria", "Africa", "Western Africa", 220000000, 480],
  ["NLD", "Netherlands", "Europe", "Western Europe", 18000000, 1100], ["NZL", "New Zealand", "Oceania", "Australia and New Zealand", 5200000, 250],
  ["PAK", "Pakistan", "Asia", "Southern Asia", 240000000, 340], ["PER", "Peru", "South America", "Andean", 34000000, 270],
  ["PHL", "Philippines", "Asia", "Southeast Asia", 117000000, 440], ["POL", "Poland", "Europe", "Eastern Europe", 38000000, 810],
  ["RUS", "Russia", "Europe", "Eastern Europe", 144000000, 2000], ["SAU", "Saudi Arabia", "Asia", "Middle East", 36000000, 1100],
  ["SWE", "Sweden", "Europe", "Nordic Countries", 10500000, 590], ["THA", "Thailand", "Asia", "Southeast Asia", 72000000, 510],
  ["TUR", "Turkey", "Asia", "Middle East", 85000000, 1100], ["USA", "United States", "North America", "Northern America", 335000000, 27000],
  ["VNM", "Vietnam", "Asia", "Southeast Asia", 99000000, 430], ["ZAF", "South Africa", "Africa", "Southern Africa", 60000000, 380],
];
const CAPITALS: Record<string, string> = {
  ARG: "Buenos Aires", AUS: "Canberra", BRA: "Brasilia", CAN: "Ottawa", CHN: "Beijing", DEU: "Berlin", EGY: "Cairo", ESP: "Madrid", ETH: "Addis Ababa",
  FRA: "Paris", GBR: "London", IDN: "Jakarta", IND: "New Delhi", IRN: "Tehran", ITA: "Rome", JPN: "Tokyo", KEN: "Nairobi", KOR: "Seoul", MEX: "Mexico City",
  NGA: "Abuja", NLD: "Amsterdam", NZL: "Wellington", PAK: "Islamabad", PER: "Lima", PHL: "Manila", POL: "Warsaw", RUS: "Moscow", SAU: "Riyadh", SWE: "Stockholm",
  THA: "Bangkok", TUR: "Ankara", USA: "Washington", VNM: "Hanoi", ZAF: "Pretoria",
};
const SYL = ["ka", "to", "ri", "na", "mo", "lu", "ve", "sa", "di", "po", "en", "ar", "ul", "is", "om", "ba", "ne", "li", "tra", "ston"];

function world(db: Database): { rows: number; tables: string[] } {
  const r = rng(1999);
  db.exec(`
    DROP TABLE IF EXISTS cities; DROP TABLE IF EXISTS countries; DROP TABLE IF EXISTS languages;
    CREATE TABLE countries (code TEXT PRIMARY KEY, name TEXT NOT NULL, continent TEXT NOT NULL, region TEXT NOT NULL, population INTEGER NOT NULL, gdp_usd_bn REAL NOT NULL);
    CREATE TABLE cities (id INTEGER PRIMARY KEY, name TEXT NOT NULL, country_code TEXT NOT NULL, population INTEGER NOT NULL, is_capital INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE languages (country_code TEXT NOT NULL, language TEXT NOT NULL, is_official INTEGER NOT NULL, percentage REAL NOT NULL, PRIMARY KEY (country_code, language));
  `);
  let rows = 0;
  db.exec("BEGIN");
  try {
    const c = new Inserter(db, "countries");
    const city = new Inserter(db, "cities");
    const lang = new Inserter(db, "languages");
    let id = 1n;
    for (const [code, name, continent, region, pop, gdp] of COUNTRIES) {
      c.run([code, name, continent, region, BigInt(pop), gdp]); rows++;
      const capPop = BigInt(Math.floor(pop * (0.02 + r() * 0.08)));
      city.run([id++, CAPITALS[code] ?? name, code, capPop, 1n]); rows++;
      const n = 4 + Math.floor(r() * 10);
      for (let i = 0; i < n; i++) {
        const nm = (pick(r, SYL) + pick(r, SYL) + pick(r, SYL)).replace(/^./, (ch) => ch.toUpperCase());
        city.run([id++, nm, code, BigInt(Math.floor(pop * r() * r() * 0.05) + 20000), 0n]); rows++;
      }
      const langs = ["English", "Spanish", "Mandarin", "Hindi", "Arabic", "Portuguese", "French", "German", "Japanese", "Swahili"];
      const k = 1 + Math.floor(r() * 3);
      const used = new Set<string>();
      let left = 100;
      for (let i = 0; i < k; i++) {
        const l = pick(r, langs);
        if (used.has(l)) continue;
        used.add(l);
        const pct = i === k - 1 ? left : Math.round(left * (0.4 + r() * 0.5));
        left -= pct;
        lang.run([code, l, i === 0 ? 1n : 0n, pct]); rows++;
      }
    }
    c.flush(); city.flush(); lang.flush();
    db.exec("COMMIT");
  } catch (e) { db.exec("ROLLBACK"); throw e; }
  db.exec("CREATE INDEX idx_cities_country ON cities(country_code); CREATE INDEX idx_cities_pop ON cities(population); ANALYZE");
  return { rows, tables: ["countries", "cities", "languages"] };
}

export function loadDataset(db: Database, name: DatasetName): { ms: number; rows: number; tables: string[] } {
  const t0 = performance.now();
  const r = name === "tpch_mini" ? tpchMini(db) : name === "orders_50k" ? orders50k(db) : world(db);
  return { ms: performance.now() - t0, ...r };
}
