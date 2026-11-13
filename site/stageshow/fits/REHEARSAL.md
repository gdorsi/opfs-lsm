# Rehearsal: fits

Gold: `story` (related objects tied by measured connectors), in the frame of this page's own `adapters` card. Kept from `adapters`: one card pinned a gutter from the top and both sides and off the bottom, a column per case with a hairline between columns, and the column head as a title over one line of detail. Kept from `story`: separate objects joined by `Connector`s measured from their `data-target`s. Changed: each column is a vertical chain. A quiet outlined "Server" sits on top, then a dashed gray "sync" line, then the library as a white node. An accent "stores" line with an arrow runs from the library down to the opfs-lsm node, which carries its package. A short line runs from that node into a well-colored OPFS floor that spans the card. The opfs-lsm nodes are the only accent, and their tops line up across all four columns.

Beats: none. On the owner's call it is a still: no script and no play, so the one frame is the finished four columns.

Captured: `--still --gate` at full width (1152 in the default viewport, plus 1440) and at 390 (also 800, where the compact design shows), light and dark at both widths, all on the real home page on the dev server at :5320. An earlier animated version passed `--gate` on the loop, `--states` and `--reduced` at both widths, before the owner asked for a still.

Gate: rehearsal passed (necessary, not sufficient: references/verify.md and the fresh eye in review.md still stand)

Film:
- `near aligned: span.fi-lsm-name "opfs-lsm" and span "@opfs-lsm/kv"` (wide) → the opfs-lsm node centered two lines of different widths. Its lines now share a left edge. Passed after.
- `uneven padding: div.fi-lsm has bottom 4px` (wide) → the node had a fixed height that the two-package column overflowed. It now pads 12px on every side and grows. Its top still lines up with the other columns. Passed after.
- `lands on a transform` on the arriving nodes → this went away with the motion.
- `uneven gutters: div.fi-lsm … 291px from the bottom` (390) → in the narrow design opfs-lsm sat in a two-column grid, with OPFS as its own chip on the left. The fix was a layout change, not a mark. opfs-lsm now spans the card with OPFS named inside it, and the card pads 12px, so the node is wider than 92% of the card. Passed after.
- The narrow "cached records and queued mutations" label ran past the card's right edge when it hung from the library's center → the store line now drops down the middle of opfs-lsm. Seen in the still, fixed.

Review: no fresh-eye subagent ran, because the brief said to spawn none. Compared with `story` by eye: the eye lands on the row of opfs-lsm nodes, which is the payoff. The servers are the quietest objects. The words carry the content and there are no filler bars.

Assumptions: every word but "Server", "sync", "opfs-lsm", "OPFS" and the floor's line "the browser's file storage for your site" comes from the `fits:` frontmatter. A package field with several packages, separated by commas, renders one package per line. In the narrow design the server shows its word without a glyph, so the library's name stays on one line, and "sync" sits above its short dashed line instead of in a pill.

Unresolved: the wrapper always renders a Replay button. On a still it remounts the same frame. Removing it needs a change in `Illustration.vue`, which this folder doesn't own. The narrow design is 1016px tall.

Not checked: a real phone, Safari and Firefox, a tablet width between 720 and 1152 (the wide design scales down there), and the Replay button's behavior.
