export class BasaltError extends Error {
  constructor(message: string, public readonly code: string = "ERROR") { super(message); this.name = "BasaltError"; }
}
export class SyntaxError_ extends BasaltError { constructor(m: string, public readonly line?: number, public readonly col?: number) { super(m, "SYNTAX"); this.name = "SyntaxError"; } }
export class BindError extends BasaltError { constructor(m: string) { super(m, "BIND"); this.name = "BindError"; } }
export class ConstraintError extends BasaltError { constructor(m: string) { super(m, "CONSTRAINT"); this.name = "ConstraintError"; } }
export class TransactionError extends BasaltError { constructor(m: string) { super(m, "TRANSACTION"); this.name = "TransactionError"; } }
export class StorageError extends BasaltError { constructor(m: string) { super(m, "STORAGE"); this.name = "StorageError"; } }
export class CorruptionError extends StorageError { constructor(m: string) { super(m); this.name = "CorruptionError"; } }
