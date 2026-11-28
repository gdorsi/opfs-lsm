export { openDatabase, type Collection, type Database, type Draft, type OpenOptions } from "./database.js";
export { collection, type CollectionDef, type Collections, type JsonDoc, type StandardIssue } from "./schema.js";
export { and, eq, gt, gte, ilike, inArray, like, lt, lte, not, or, type Expression, type Ref, type Scalar } from "./expr.js";
export type { Buildable, QueryBuilder, QueryRoot } from "./builder.js";
export { query, type LiveQuery, type PlanSummary } from "./live.js";
export {
  ClosedError,
  ConflictError,
  DbError,
  NotFoundError,
  QueryError,
  SchemaError,
  StorageError,
  ValidationError,
  type AnyDbError,
  type DbErrorTag,
} from "./errors.js";
