# Contributing to Basalt

Thanks for taking a look. Basalt is small enough to read end to end; `docs/ARCHITECTURE.md` is the contract every module follows and is the first thing to read. Where the code and that document disagree, fix one of them in the same change.

## Setup

```
npm install          # Node 22 or later
npm test             # vitest: storage, sql, slt suites
npm run typecheck    # tsc --noEmit (strict, noUncheckedIndexedAccess)
npm run fuzz         # differential fuzzing against node:sqlite
npm run dev          # web app on http://localhost:5173
npm run build        # typecheck + vite build to web/dist
```

## Rules of the road

- Zero runtime dependencies in `src/`. The web app may use dev dependencies only.
- Lower layers never import upper layers: `core` imports nothing, `storage` does not know about SQL, the planner does not know about operators.
- Everything above the backend is synchronous. Async code lives only in `storage/backend` implementations and in `Database.open` / `close`.
- INTEGER is `bigint` end to end. Do not convert to `number` unless the value is a safe integer and the result cannot overflow.
- Every SQL feature needs a sqllogictest case in `tests/slt/*.slt` (`statement ok`, `statement error`, `query <types> [nosort|rowsort]`). Behaviour that must match SQLite needs the fuzzer to agree; a deliberate divergence goes in `docs/SQLITE-DIVERGENCES.md`.
- Storage changes need a unit test in `tests/storage` and, when they touch commit or free-list logic, a crash-simulation case.
- Plain text only: no em dashes, en dashes, smart quotes or arrow characters in code, comments, docs or UI strings (`node scripts/lint-text.mjs` checks this).

## Pull requests

Keep them focused: one feature or fix per PR, with the test that proves it. Describe the user-visible behaviour in the first line of the description and the design decision, if any, in the body. Run `npm test` and `npm run typecheck` before opening it.

## Reporting bugs

A failing `.slt` case or a short script against `Database.open({ memory: true })` is the most useful report. For storage bugs, the output of `PRAGMA page_count`, `PRAGMA freelist_count` and `db.stats()` before and after the failing statement helps.
