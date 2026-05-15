# Step 4 — Benchmark source vs target, then optimise

The demo's punchline: show the partner how much faster ClickHouse is on
the same workload, then squeeze more out of it. Use the source + target
databases established in steps 1–3 and the queries rewritten in step 3.

## Benchmarking — one script, one library call

The migrationkit library runs every query against both engines from
inside a single Python process holding both connectors and times each
side identically — fair source-vs-target comparison, no engine-specific
timing API to wrangle.

```python
from migrationkit import Benchmarker, SnowflakeSource, ClickHouseTarget

Benchmarker(
    run_id="<run-id-from-step-2>",
    source=SnowflakeSource.from_env(),
    target=ClickHouseTarget.from_env(),
    target_database="<target-db-from-step-1>",
).benchmark(queries=[
    {
        "name": "Q1: daily revenue",
        "source_sql": "<original Snowflake SQL from {olap_queries}>",
        "target_sql": "<rewritten ClickHouse SQL from step 3>",
    },
    # ... one entry per query in the partner's analytical set ...
])
```

The partner's current query set:

```sql
{olap_queries}
```

What `benchmark(...)` does:

- Wall-clocks `source_sql` against Snowflake and `target_sql` against
  ClickHouse Cloud, captures `(rows, ms)` for each side.
- Persists per-query results into the `benchmarks` table and emits
  events the dashboard's **Benchmark** tab renders live (one row
  appears as each query finishes).
- A query that errors on one side captures the error in
  `source_error` / `target_error` and continues with the next query —
  one bad rewrite doesn't kill the run.
- Emits `step_benchmarked` at the end — that lights up the step-4
  checkmark. **Do not** also curl `/mark/benchmarked`.

Dispatch + one tail (raise `max_wait_seconds` for query sets with
long-running source queries):

```text
1.  call: write_workspace_file(path="benchmark.py", content=<script above>)
2.  call: run_python_background(code=<read of benchmark.py>)    ← capture job_id
3.  call: tail_python_job(job_id=..., max_wait_seconds=120)
```

Read the per-query summary from `stdout_delta` (each query gets one
line). Surface one short paragraph in chat — e.g. *"6 queries, avg
23× speedup, lineitem Q4 hit a parse error on the target — see the
Benchmark tab for details."* Don't paste the full comparison; the
dashboard's Benchmark tab renders it.

If any query errored on the target side, that's usually a SQL-dialect
issue with the rewrite — fix the rewrite, re-run `Benchmarker` (it
overwrites the prior rows for the same run_id), and surface the
correction in chat.

---

## Optimisation pass — in chat, then re-benchmark

Inspect the dashboard's Benchmark tab (or the stdout summary). For any
query where:

- The target was slower than expected (target_ms > source_ms), or
- The speedup is weak (<3×), or
- An obvious bottleneck appears in the SQL

…propose one targeted change:

- **PROJECTION** when the target's `ORDER BY` doesn't align with this
  query's predicate / join key.
- **Computed column** or query rewrite when a time filter is wrapped
  in a function (non-sargable).
- **AggregatingMergeTree materialised view** with `groupArray` / `sum`
  / `avg` states for aggregation-heavy queries that scan large fact
  tables.

Apply **the single highest-leverage change** via `clickhousectl`
(`ALTER TABLE … ADD PROJECTION …` or `CREATE MATERIALIZED VIEW …`),
then re-run the same `Benchmarker.benchmark(...)` script — the new
results overwrite the previous run in-place, so the Benchmark tab
updates without manual cleanup.

Surface the before/after numbers for the optimised query in chat and
tell the partner what changed.

---

## When you're done

Tell the partner:

1. Headline speedup (e.g. *"avg 18× across 6 queries, max 45× on Q3"*).
2. Any queries that didn't speed up — what you tried, what worked.
3. *"Full per-query timings are in the dashboard's Benchmark tab."*

The dashboard's step-4 checkmark lights up automatically when
`Benchmarker.benchmark()` completes.

---

## Tool-call budget

Roughly 4–6 tool calls total:

1. `write_workspace_file(path="benchmark.py", …)`
2. `run_python_background(code=...)` → job_id
3. `tail_python_job(job_id, max_wait_seconds=120)` — read summary
4. (chat: identify the optimisation target)
5. (optional) `clickhousectl` call to apply the projection / MV
6. (optional) re-dispatch `benchmark.py` and tail once more

If you find yourself making more, you're either polling the tail or
re-implementing benchmark mechanics the library handles. Use
`Benchmarker`.
