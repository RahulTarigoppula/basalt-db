/** Browser stand-in for `src/storage/node-backend.ts`, which needs `node:fs`. `Database.open({ file })` throws before reaching it. */
export class NodeFileBackend {
  static open(_path: string): never { throw new Error("file-backed databases need Node"); }
}
