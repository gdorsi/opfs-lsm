---
"@opfs-lsm/tanstack-db": patch
---

The docs of `utils.transact` state when the collection shows its write: while another transaction on the collection is persisting, TanStack applies the synced row once that transaction settles.
