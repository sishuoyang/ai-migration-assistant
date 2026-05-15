# Step 5 — Benchmark source vs target

Time every analytical query on both engines. The dashboard's **Benchmark**
tab renders the comparison live. Use the rewritten queries from step 4 —
read them from the chat scrollback; don't re-derive them.

## One script, one library call

Timing is **server-side**: Postgres queries are wrapped in
`EXPLAIN (ANALYZE, FORMAT JSON, BUFFERS)` so `Execution Time` is read
from the plan; ClickHouse uses `X-ClickHouse-Summary.elapsed_ns`. This
keeps the comparison network-neutral. Wall-clock is also captured as a
secondary diagnostic.

> **Read-only only.** `EXPLAIN ANALYZE` actually executes the wrapped
> statement, so any DML (`INSERT` / `UPDATE` / `DELETE`) would run on
> the source. Benchmark only `SELECT` queries.

```python
from migrationkit import Benchmarker, PostgresSource, ClickHouseTarget

Benchmarker(
    run_id="<run-id-from-step-2>",
    source=PostgresSource.from_env(),
    target=ClickHouseTarget.from_env(),
    target_database="<target-db-from-step-1>",
).benchmark(queries=[
    {
        "name": "<short descriptive label>",
        "source_sql": "<original Postgres SQL from step 4>",
        "target_sql": "<rewritten ClickHouse SQL from step 4>",
    },
    # ... one entry per query you rewrote in step 4 ...
])
```

What `benchmark(...)` does:

- Captures **server-side execution time** for `source_sql` on Postgres
  (via `EXPLAIN ANALYZE`'s `Execution Time`) and `target_sql` on
  ClickHouse Cloud (via `X-ClickHouse-Summary.elapsed_ns`); also records
  the wall-clock bracket for transparency.
- Persists per-query results in the `benchmarks` table; events feed
  the **Benchmark** tab live.
- A query that errors on one side records the error in `source_error`
  / `target_error` and continues — one bad rewrite doesn't kill the
  run.
- Emits `step_benchmarked` — lights up the step-5 checkmark.

## Dispatch + one tail

```text
1.  call: write_workspace_file(path="benchmark.py", content=<script above>)
2.  call: run_python_background(code=<read of benchmark.py>)    ← capture job_id
3.  call: tail_python_job(job_id=..., max_wait_seconds=120)
```

`max_wait_seconds=120` is the right starting point — raise it if any
query is slower than that on Postgres.

Surface a one-paragraph result in chat. For example: *"N queries · avg
speedup X× · max Y× on the heaviest one. One query hit a parse error
on the target — I'll fix that rewrite. Full per-query timings in the
**Benchmark** tab."*

If any query errored on the target side, fix the rewrite in chat,
**re-run the same `Benchmarker.benchmark(...)` script** (it overwrites
prior rows for the same run_id by `query_n`), and confirm the fix
landed. Then move on to step 6 (Optimize).
