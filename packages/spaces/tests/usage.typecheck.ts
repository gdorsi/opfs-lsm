// The rationale's Usage section, compiled against the sketch's types.
// `@ts-expect-error` lines are the type errors the README promises.
import { z } from "zod";
import type { Db } from "@opfs-lsm/kv";
import {
  between,
  collection,
  defineSchema,
  file,
  openSpaces,
  ref,
  richText,
  websocket,
  type RecordId,
  type Row,
} from "../src/index.js";

declare const kv: Db;
declare function renderList(rows: readonly Row<typeof Todo>[]): void;

const List = collection("lists", { title: z.string().min(1) });
const Todo = collection(
  "todos",
  {
    list: ref("lists"),
    title: z.string().min(1),
    done: z.boolean().default(false),
    position: z.string(),
  },
  { indexes: { byList: ["list", "position"] } },
);
const Chat = collection("chats", { title: z.string() });
const Message = collection(
  "messages",
  {
    chat: ref("chats"),
    text: z.string().max(4000),
    image: file().optional(),
    sentAt: z.number(),
  },
  { indexes: { byChat: ["chat", "sentAt"] } },
);
const Note = collection("notes", { title: z.string(), body: richText() });

const schema = defineSchema({ version: 1, collections: [List, Todo, Chat, Message, Note] });

// A ref to a collection the schema lacks is a type error.
const Orphan = collection("orphans", { owner: ref("users") });
// @ts-expect-error ref to a collection the schema lacks
defineSchema({ version: 1, collections: [Orphan] });

// A reserved name is a type error.
const Bad = collection("spaces", { x: z.string() });
// @ts-expect-error collection name "spaces" is reserved
defineSchema({ version: 1, collections: [Bad] });

// A validator whose output is not JSON is a type error.
// @ts-expect-error z.date() outputs a Date: use z.iso.datetime() or a number
collection("dated", { at: z.date() });
collection("dated2", { at: z.iso.datetime(), n: z.number(), tags: z.array(z.string()), o: z.object({ a: z.string().optional() }) });

// Index fields must be scalar fields.
// @ts-expect-error "image" is not a scalar field
collection("m2", { image: file() }, { indexes: { byImage: ["image"] } });

async function main() {
  const db = await openSpaces(schema, { kv, server: websocket("wss://sync.example.com") });

  const inbox = await db.lists.create({ title: "Inbox" });
  const mine = await db.todos.create({ list: inbox.id, title: "Call mom", position: between() });
  const sameSpace: boolean = db.spaces.of(mine.id) === db.spaces.personal;

  // Call site 1
  const space = await db.spaces.create();
  const list = await db.lists.create({ title: "Groceries" }, { space });
  const todo = await db.todos.create({ list: list.id, title: "Milk", position: between() }, { space });
  const link = await space.invite("writer");
  const joined = await db.spaces.join(link);
  const stop = db.todos.watch({ index: "byList", eq: [list.id] }, (todos) => renderList(todos));
  await db.todos.update(todo.id, { position: between(undefined, todo.position) });
  await db.todos.update(todo.id, { done: true });
  await db.todos.delete(todo.id);
  const done = await db.todos.query({ index: "byList", eq: [list.id], filter: (t) => t.done });
  await db.transact((tx) => {
    for (const t of done.rows) tx.todos.delete(t.id);
  });
  const { members } = await space.members();
  const other = members.find((m) => !m.me);
  if (other) await space.remove(other.id);

  // Call site 2
  async function send(chatId: RecordId<"chats">, text: string, picked?: File) {
    const space = db.spaces.of(chatId)!;
    const image = picked && (await db.files.put(picked, { space }));
    await db.messages.create({ chat: chatId, text, image, sentAt: Date.now() }, { space });
  }
  const chat = await db.chats.create({ title: "Team" });
  const page = await db.messages.query({ index: "byChat", eq: [chat.id], reverse: true, limit: 50, resolve: { chat: true } });
  const title: string | undefined = page.rows[0]?.chat?.title;
  for (const m of page.rows) {
    if (m.image) URL.createObjectURL(await db.files.read(m.image));
  }

  // Call site 3
  const note = await db.notes.create({ title: "Plan" }, { space });
  const body = await db.notes.open(note.id, "body");
  body.doc.getXmlFragment("doc");
  body.release();
  // @ts-expect-error "title" is not a rich-text field
  await db.notes.open(note.id, "title");
  await db.notes.delete(note.id);

  // Call site 4
  const got = await db.todos.get(todo.id, { resolve: { list: true } });
  const listTitle: string | undefined = got?.list?.title;
  const pos: string | undefined = got?.position;
  // @ts-expect-error `list` comes first in byList, so a bound needs eq
  await db.todos.query({ index: "byList", gt: "x" });
  // @ts-expect-error `list` and `position` are required
  await db.todos.create({ title: "x" });
  // @ts-expect-error done is a boolean
  await db.todos.update(todo.id, { done: "yes" });
  // @ts-expect-error a list id is not a todo id
  await db.todos.update(list.id, { done: true });
  // @ts-expect-error a ref takes an id of the target collection
  await db.todos.create({ list: chat.id, title: "x", position: between() });

  const _: unknown[] = [sameSpace, joined, stop, title, listTitle, pos, send, mine];
}
void main;
