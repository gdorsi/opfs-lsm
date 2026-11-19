---
"@opfs-lsm/docstore": minor
---

A collection is declared with `collection<T>()` and one method per kind of index: `index`, `unique` and `text`. `defineSchema<{ todos: Todo }>()({ ... })` is gone, with the index objects it took. `defineSchema(schema)` now takes one call and returns its argument typed. `IndexDecl` is no longer exported; `CollectionDecl` is the type of a declaration.

Before:

```ts
const schema = defineSchema<{ todos: Todo }>()({
	version: 1,
	collections: {
		todos: {
			open: { by: ["done", "createdAt"] },
			byTag: { by: "tags[]" },
			byTitle: { by: "title", unique: true },
			search: { by: "createdAt", text: "title" },
		},
	},
});
```

After:

```ts
const schema = defineSchema({
	version: 1,
	collections: {
		todos: collection<Todo>()
			.index("open", ["done", "createdAt"])
			.index("byTag", "tags[]")
			.unique("byTitle", "title")
			.text("search", "createdAt", "title"),
	},
});
```

A text index cannot be unique and cannot start with an array field, and an index name cannot repeat: each is a type error now. Every method returns a new declaration, so a base declaration can be shared. The stored catalog does not change, so an existing database opens as before.
