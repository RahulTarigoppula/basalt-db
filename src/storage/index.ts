/**
 * Storage layer barrel. `NodeFileBackend` is deliberately not re-exported here (it imports `node:fs`);
 * import it from `./node-backend` in Node-only entry points.
 */
export * from "./backend";
export * from "./page";
export * from "./meta";
export * from "./bufferpool";
export * from "./pager";
export * from "./freelist";
export * from "./btree";
export { OpfsBackend } from "./opfs-backend";
export { IndexedDbBackend } from "./idb-backend";
export { CrashSimBackend } from "./testing";
