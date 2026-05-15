# Step 4 — Rewrite the analytical queries for ClickHouse Cloud

Source and target are both ClickHouse, so most queries port verbatim.
**This step is pure reasoning — no tool calls.** Your job here is to
find the few queries that won't, fix them, and keep the rewrites in
chat for step 5 (Benchmark) to reference.

## Queries to review

```sql
{olap_queries}
```

## What changes on Cloud

Cloud is one logical cluster — it handles replication, sharding, and
fault tolerance for you. The OSS-specific patterns below need attention:

| OSS pattern | Cloud rewrite |
|---|---|
| `ON CLUSTER '<cluster>'` in DDL or DML | drop `ON CLUSTER` entirely |
| `cluster(<cluster>, <db>, <table>)` table function | read directly: `<db>.<table>` |
| `remote(...)` / `remoteSecure(...)` against another OSS shard | obsolete — all data is now in one place |
| Distributed table reads (`SELECT FROM <distributed_table>`) | read the local target table directly |
| `_shard_num` / `_shard_count` virtual columns in projection | not available; usually safe to drop |
| Reads of `Buffer(...)` engine tables on the source | the buffer engine doesn't exist on Cloud — read the underlying table |
| `arrayMap` / `arrayFilter` etc. with the older parameter order | verify against current docs — the dialect is identical, but a few old aliases are deprecated |

Everything else (window functions, JSON functions, array operations,
aggregate functions, joins, CTEs, subqueries) carries over unchanged.

For each query, decide:

- **No changes** → state that explicitly in chat. Don't write a
  re-formatted copy.
- **Needed changes** → show the original and the rewrite side-by-side
  with a one-line explanation. Reference the **clickhouse-docs** MCP
  for anything you're unsure about (it's authoritative on which OSS
  patterns map to which Cloud equivalents).

## When you're done

Tell the partner:

1. How many of the N queries needed rewrites (often 0–2 out of all
   queries when migrating from a recent OSS version).
2. *"Click step 5 (Benchmark) to time them against the source and
   verify they parse on the target."*

Step 5 will read your rewrites from the chat scrollback when it builds
its `Benchmarker.benchmark(queries=[...])` call.
