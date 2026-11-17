# Size cap

How the host measures a database opened with `maxBytes`, and how a tab frees space when asked.
What the cap promises is in [design.md](design.md#size-cap).

The host holds the smallest numeric `maxBytes` any open tab passed, and whether any tab passed
`"quota"`, until the last tab closes the database. Both apply at once. Nothing about the cap is
stored.

**Measure.** A compaction pass that finds nothing left to plan measures its manifest: `bytes` is
the sum of its runs' file bytes. A pass runs after each flush and when a tab opens the database
with `maxBytes`. Covered and overwritten versions count until a merge drops them; the WAL and the
retired runs a `view` holds do not count.

**Quota.** With `"quota"`, a measure that finds the numeric cap met or absent, and no run file on
disk outside its manifest, reads `navigator.storage.estimate()` after the pass, holding no lock. A
retired run that a tab still holds counts in the estimate, so the read waits for a pass after it
is gone. The cap is then 90% of `quota`,
rounded down, and `need` is `usage` less 4/5 of it. `bytes` stays the sum of the runs' file bytes.
The estimate covers the whole origin (the WAL in IndexedDB, other databases, caches) and is
approximate, so `need` can pass `bytes`: a handler that frees `need` regardless empties the
database. Each database opened with `"quota"` is offered the whole `need`. A missing or rejected estimate, or one
without `usage` or `quota`, makes no offer.

**Offer.** Over a cap, the host posts `{ kind: "pressure", pressure: { bytes, maxBytes, need } }`
on the layers channel, with `need` the bytes over 4/5 of the cap. It holds one of two states:

| State | Event | Next |
|---|---|---|
| after `s` | a measure over the cap, of a manifest whose `through` is at least `s` | open, posted |
| open | `pressure-pull` | open, posted again |
| open | `pressure-done` | after the WAL head |
| any | the last tab closes the database | after 0 |

An answer counts only once a flush holds what the handlers wrote. Handlers that wrote nothing
leave the manifest at the WAL head, so the host asks again at most once per compaction pass. A
pass that stops at its step limit measures nothing: under heavy writes the offer waits for a pass
that finishes. An open offer keeps the numbers it was posted with, and no other offer follows
until a holder posts `pressure-done`. The three messages are posted once each: if the channel
loses one, offers stop until the holder's handle closes. A new host starts at "after 0".

**Answer.** A handle with an `onPressure` handler asks for the Web Lock
`opfs-lsm-pressure/<name>` and keeps it while it has one. On the grant it posts `pressure-pull`,
for an offer posted while another handle held the lock. Only the holder answers: it calls its
handlers in turn, then posts `pressure-done`, whether they resolved or threw. A holder that closes
mid-answer, or whose tab goes away, posts nothing, and the next holder pulls the offer. A handle
opened with `maxBytes` and no handler asks for the lock shared with `ifAvailable` on each offer;
granted, no handle answers, and it warns.
