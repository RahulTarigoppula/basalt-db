/**
 * Cost model constants. Costs are abstract units: one sequentially read 4 KB page costs 1.0; everything else is
 * expressed relative to that (the ratios follow PostgreSQL's defaults).
 */
export const COST = {
  /** Sequential page read. */
  SEQ_PAGE: 1.0,
  /** Random page read (index -> table lookup, B+tree descent). */
  RANDOM_PAGE: 1.25,
  /**
   * Per row fetched from the table by rowid after an index match. Measured in Node a cached B+tree descent plus the
   * record decode costs about twice a sequential row, not a disk page: with the buffer pool holding the hot interior
   * pages, `RANDOM_PAGE` per lookup made an index range over 4% of a table lose to a full scan.
   */
  ROWID_LOOKUP: 0.08,
  /** Per row handled by an operator (decode, copy, pass on). */
  CPU_TUPLE: 0.01,
  /** Per expression evaluated per row (predicates, projections, hash keys). */
  CPU_EXPR: 0.0025,
  /** Per row inserted into a hash table. */
  HASH_BUILD: 0.02,
  /** Per row probed against a hash table. */
  HASH_PROBE: 0.01,
  /** Per comparison while sorting (rows · log2 rows comparisons). */
  SORT_CMP: 0.005,
  /** Per row materialised into a buffer. */
  MATERIALIZE: 0.005,
} as const;

/** Rows that fit in one leaf page for a table with `columns` columns (~ 10 bytes per column + overhead). */
export function rowsPerPage(columns: number): number {
  return Math.max(1, Math.floor(4000 / (columns * 10 + 12)));
}

/** Estimated leaf pages of a table. */
export function tablePages(rows: number, columns: number): number {
  return Math.max(1, Math.ceil(rows / rowsPerPage(columns)));
}

/** B+tree descent cost (interior pages touched). */
export function descentCost(rows: number, columns: number): number {
  const pages = tablePages(rows, columns);
  return COST.RANDOM_PAGE * Math.max(1, Math.ceil(Math.log(pages + 1) / Math.log(100)));
}

export function seqScanCost(rows: number, columns: number, predicates: number): number {
  return tablePages(rows, columns) * COST.SEQ_PAGE + rows * (COST.CPU_TUPLE + predicates * COST.CPU_EXPR);
}

/** Index scan returning `matched` entries; non-covering scans add one random page per row for the table lookup. */
export function indexScanCost(tableRows: number, matched: number, indexColumns: number, covering: boolean, predicates: number): number {
  const leafPages = Math.max(1, Math.ceil(matched / rowsPerPage(indexColumns + 1)));
  const lookups = covering ? 0 : matched * COST.ROWID_LOOKUP;
  return descentCost(tableRows, indexColumns + 1) + leafPages * COST.SEQ_PAGE + lookups + matched * (COST.CPU_TUPLE + predicates * COST.CPU_EXPR);
}

export function sortCost(rows: number): number {
  const n = Math.max(1, rows);
  return n * Math.log2(n + 1) * COST.SORT_CMP + n * COST.CPU_TUPLE;
}

export function topKCost(rows: number, k: number): number {
  const n = Math.max(1, rows);
  return n * Math.log2(Math.max(2, k + 1)) * COST.SORT_CMP + n * COST.CPU_TUPLE;
}

export function hashJoinCost(buildRows: number, probeRows: number, outRows: number): number {
  return buildRows * COST.HASH_BUILD + probeRows * COST.HASH_PROBE + outRows * COST.CPU_TUPLE;
}

export function nestedLoopCost(outerRows: number, innerRows: number, outRows: number): number {
  return innerRows * COST.MATERIALIZE + outerRows * innerRows * (COST.CPU_EXPR + COST.CPU_TUPLE * 0.1) + outRows * COST.CPU_TUPLE;
}

export function mergeJoinCost(leftRows: number, rightRows: number, outRows: number): number {
  return (leftRows + rightRows) * COST.CPU_EXPR + outRows * COST.CPU_TUPLE;
}

export function hashAggregateCost(rows: number, groups: number, aggs: number): number {
  return rows * (COST.HASH_PROBE + aggs * COST.CPU_EXPR) + groups * COST.CPU_TUPLE;
}
