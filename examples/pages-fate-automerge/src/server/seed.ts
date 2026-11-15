import { interpretAsDocumentId } from "@automerge/automerge-repo";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PageId } from "../model/types.ts";
import { insertPage } from "./pages.ts";

type SeedTree = readonly { readonly title: string; readonly children?: SeedTree }[];

const DEMO_TREE: SeedTree = [
  { title: "Getting started", children: [{ title: "Welcome" }, { title: "Writing pages" }, { title: "Keyboard shortcuts" }] },
  {
    title: "Projects",
    children: [
      { title: "Website redesign", children: [{ title: "Research" }, { title: "Launch plan" }] },
      { title: "Mobile app", children: [{ title: "Roadmap" }] },
    ],
  },
  { title: "Journal", children: [{ title: "Monday" }, { title: "Tuesday" }] },
  { title: "Reading list" },
];

/**
 * A page's id is derived from its title path, so a reseed gives the same ids
 * and the bodies a browser holds for them stay attached.
 */
const seedId = (path: readonly string[]): PageId =>
  interpretAsDocumentId(createHash("sha256").update(`pages-seed:${path.join("/")}`).digest().subarray(0, 16) as never);

/** Replaces every page with the demo tree. Bodies are not seeded: they live on each device. */
export function seedDb(db: DatabaseSync, tree: SeedTree = DEMO_TREE): { readonly pages: number } {
  let pages = 0;
  const insert = (nodes: SeedTree, parent: { id: PageId; path: readonly string[] } | null) => {
    for (const node of nodes) {
      const path = [...(parent?.path ?? []), node.title];
      const id = seedId(path);
      insertPage(db, { id, parentId: parent?.id ?? null, title: node.title });
      pages++;
      insert(node.children ?? [], { id, path });
    }
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DELETE FROM page; DELETE FROM receipt");
    insert(tree, null);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { pages };
}
