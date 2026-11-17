/**
 * Public surface of @opfs-lsm/spaces. Everything not exported here is
 * internal. `package.json` `exports` lists only ".", "./testing" and
 * "./server", so a deep import of `local/` or `sync/` fails to resolve.
 */

export { openSpaces } from "./db.js";
export type {
  Account,
  AccountSecret,
  CollectionApi,
  OpenOptions,
  RecordStatus,
  SpacesDb,
  SyncStatus,
  Tx,
  TxCollection,
  WriteOptions,
} from "./db.js";

export { collection, defineSchema, file, ref, richText } from "./schema.js";
export type {
  CollectionDef,
  Cursor,
  Input,
  Page,
  Patch,
  Query,
  Resolved,
  ResolveSpec,
  Row,
  SchemaDef,
  StandardSchemaV1,
} from "./schema.js";

export { between, keyedRecordId } from "./ids.js";
export type { FileId, MemberId, RecordId, SpaceId } from "./ids.js";

export type { FileRef, Files } from "./files.js";
export type { RichTextLease } from "./richtext.js";
export type { Invite, InviteLink, Member, Space, Spaces, Standing } from "./space/spaces.js";
export type { Role } from "./sync/protocol.js";

export { websocket } from "./sync/transport.js";
export type { Transport } from "./sync/transport.js";
export { webLocksLeader } from "./sync/engine.js";
export type { LeaderElection } from "./sync/engine.js";

export { SpacesError } from "./errors.js";
export type { SpacesErrorCode } from "./errors.js";
