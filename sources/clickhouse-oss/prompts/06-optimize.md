# Step 6 — Optimize the target schema

Use the dashboard's **Benchmark** tab to find queries that lag on the
target. For each one worth optimising, pick a single high-leverage
change, apply it via **clickhousectl**, then re-run the same
`Benchmarker.benchmark(...)` script from step 5 to capture the
before/after.

The ClickHouse Cloud best-practice rules attached to **clickhousectl**
— and the **clickhouse-docs** MCP for anything else — are the
authoritative guide for which optimisation pattern fits which symptom.
Don't guess; consult them before proposing DDL.

> **OSS-specific reminder**: any `AggregatingMergeTree` materialised
> views you skipped in step 2 belong here — recreate the MV on the
> target and backfill from the migrated raw tables. The CH MCP's
> best-practice rules cover the MV + backfill pattern.

Re-running the benchmark overwrites prior rows for the same `run_id`
by `query_n`, so the **Benchmark** tab updates in place — the partner
sees the before/after just by glancing at it.

When you're done, tell the partner what you changed and by how much.
Leave further ideas as text, not code.
