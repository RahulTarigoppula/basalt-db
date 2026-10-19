/**
 * Join ordering for a region of INNER joins.
 *
 * Up to `DP_LIMIT` (8) items: dynamic programming over subsets (bitmask DP). For every subset S the cheapest plan is the
 * cheapest `join(best[L], best[R])` over all splits S = L ∪ R, where the join condition is the conjunction of every
 * predicate whose relations are covered by S but by neither side alone. Predicates connecting the two sides make the
 * split "connected"; disconnected splits (cross products) are still considered so cross joins plan, but their
 * cardinality makes them lose whenever a connected plan exists. Beyond the limit a greedy heuristic repeatedly joins
 * the pair with the cheapest result.
 *
 * The join algorithm (hash / merge / nested loop) is chosen by the `makeJoin` callback, so the DP costs the real
 * physical alternatives.
 */
import type { BoundExpr } from "../sql/bound.js";
import { conjoin } from "./build.js";

export const DP_LIMIT = 8;

export interface JoinItem<P> { plan: P; rels: Set<number> }
export interface JoinPredicate { expr: BoundExpr; rels: Set<number> }
export interface Costed { estCost: number; estRows: number }

export function orderJoins<P extends Costed>(items: JoinItem<P>[], predicates: JoinPredicate[], makeJoin: (left: P, right: P, condition: BoundExpr | undefined) => P): P {
  if (items.length === 1) return items[0]!.plan;
  const n = items.length;
  const relsOf = (mask: number): Set<number> => {
    const s = new Set<number>();
    for (let i = 0; i < n; i++) if (mask & (1 << i)) for (const r of items[i]!.rels) s.add(r);
    return s;
  };
  const covered = (p: JoinPredicate, rels: Set<number>): boolean => { for (const r of p.rels) if (!rels.has(r)) return false; return true; };
  /** Predicates usable at the join of `l` and `r` (covered by the union, not by either side). */
  const condFor = (l: Set<number>, r: Set<number>, all: Set<number>): BoundExpr | undefined => {
    const list: BoundExpr[] = [];
    for (const p of predicates) if (covered(p, all) && !covered(p, l) && !covered(p, r)) list.push(p.expr);
    return conjoin(list);
  };
  predicates = predicates.filter((p) => p.rels.size > 0); // constant conjuncts are the caller's business (see splitFloating)

  if (n <= DP_LIMIT) {
    const best = new Array<P | undefined>(1 << n);
    const rels = new Array<Set<number>>(1 << n);
    for (let i = 0; i < n; i++) { best[1 << i] = items[i]!.plan; rels[1 << i] = items[i]!.rels; }
    for (let mask = 1; mask < 1 << n; mask++) {
      if ((mask & (mask - 1)) === 0) continue; // single item
      rels[mask] = relsOf(mask);
      let bestPlan: P | undefined;
      // enumerate splits: left = non-empty proper subset of mask (each unordered pair once; makeJoin tries both sides)
      for (let left = (mask - 1) & mask; left > 0; left = (left - 1) & mask) {
        const right = mask ^ left;
        if (left < right) continue;
        const lp = best[left], rp = best[right];
        if (!lp || !rp) continue;
        const cond = condFor(rels[left]!, rels[right]!, rels[mask]!);
        const a = makeJoin(lp, rp, cond);
        if (!bestPlan || a.estCost < bestPlan.estCost) bestPlan = a;
        const b = makeJoin(rp, lp, cond);
        if (b.estCost < bestPlan.estCost) bestPlan = b;
      }
      best[mask] = bestPlan;
    }
    return best[(1 << n) - 1]!;
  }
  // greedy
  let pool = items.map((i) => ({ plan: i.plan, rels: i.rels }));
  while (pool.length > 1) {
    let bi = 0, bj = 1, bestPlan: P | undefined;
    for (let i = 0; i < pool.length; i++) for (let j = 0; j < pool.length; j++) {
      if (i === j) continue;
      const all = new Set<number>([...pool[i]!.rels, ...pool[j]!.rels]);
      const cond = condFor(pool[i]!.rels, pool[j]!.rels, all);
      const p = makeJoin(pool[i]!.plan, pool[j]!.plan, cond);
      if (!bestPlan || p.estCost < bestPlan.estCost) { bestPlan = p; bi = i; bj = j; }
    }
    const merged = { plan: bestPlan!, rels: new Set<number>([...pool[bi]!.rels, ...pool[bj]!.rels]) };
    pool = pool.filter((_, k) => k !== bi && k !== bj);
    pool.push(merged);
  }
  return pool[0]!.plan;
}

/** Splits join conjuncts into those usable by the region (referencing >= 1 relation) and the constant leftovers. */
export function splitFloating(predicates: JoinPredicate[]): { usable: JoinPredicate[]; constant: BoundExpr[] } {
  return { usable: predicates.filter((p) => p.rels.size > 0), constant: predicates.filter((p) => p.rels.size === 0).map((p) => p.expr) };
}
