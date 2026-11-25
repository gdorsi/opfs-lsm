# Covering indexes for the SQLite tracker contender

Status: rejected. Covering indexes made SQLite's card lists up to 1.33× faster but the replay 1.13× slower, the sprint close 1.50× slower and the database 1.33× larger, so `bench/contenders/tracker/sqlite.ts` keeps plain indexes. bench/README.md's "Families" table says so.

Date: 2026-11-24. Apple M5 Max, commit `ccedee1d`. The run setup is under Result.

docstore's three card indexes include the fields of an issue card, so the status page, a person's issues and the recent issues read no issue document. SQLite can do the same with indexes that hold every column a card reads. This note measures that variant against the contender as it is.

## The variant

Three indexes of `bench/contenders/tracker/sqlite.ts` gain the card's columns:

```sql
CREATE INDEX issues_project_status ON issues (projectId, status, updatedAt, id, number, title, priority, assigneeId);
CREATE INDEX issues_assignee ON issues (assigneeId, updatedAt, status, id, projectId, number, title, priority);
CREATE INDEX issues_updated ON issues (updatedAt, id, projectId, number, title, status, priority, assigneeId);
```

## Result

`tracker/goals` at size `small` (20,000 issues), 5 runs per side interleaved in one session, Apple M5 Max, commit `ccedee1d` plus the variant. Each cell is the median with its range. Every difference below is one the rank-sum test of `compare` separates.

| metric | plain indexes | covering indexes | change |
|---|---:|---:|---|
| `statusPage` warm | 0.417 ms (0.411–0.424) | 0.387 ms (0.371–0.398) | 1.08× faster |
| `statusPage` cold | 5.20 ms (5.17–5.21) | 5.04 ms (4.96–5.15) | 1.03× faster |
| `myIssues` cold | 5.70 ms (5.63–5.72) | 5.48 ms (5.47–5.61) | 1.04× faster |
| `board` warm | 1.57 ms (1.56–1.58) | 1.18 ms (1.17–1.20) | 1.33× faster |
| `board` cold | 8.85 ms (8.55–8.96) | 8.43 ms (8.25–8.68) | 1.05× faster |
| `replay` | 9,171 ops/s (9,067–9,198) | 8,118 ops/s (8,065–8,138) | 1.13× slower |
| `recent`, the sprint close | 52.0 ms (50.8–53.0) | 78.3 ms (76.4–80.2) | 1.50× slower |
| disk after the settle | 26.4 MB | 35.2 MB | 1.33× larger |

The runs do not separate the two on `myIssues` warm or on `recentActivity`. The board gains more than its four status pages gain one by one, and this note does not explain why.

## Decision

The contender keeps plain indexes. The variant trades write speed and disk for read speed, as docstore's included fields do, so adopting it is a fairness choice that moves published rows: the board row of the goals table would likely turn to SQLite, and the replay row further to docstore.
