# Step 5 — Benchmark source vs target

Time every analytical query on both engines. The dashboard's **Benchmark**
tab renders the comparison live as each query finishes. Use the
rewritten queries from step 4 — read them from the chat scrollback;
don't re-derive them.

> **BigQuery cost reminder**: every benchmark run charges the partner's
> GCP account once per query. If the query set is large or hits big
> tables, tell the partner up front: *"This benchmark will run N
> queries against BigQuery — bytes scanned shows up on your bill.
> Proceed?"*

## One script, one library call

The migrationkit library runs every query against both engines from
inside a single Python process and captures each engine's own
**server-side execution time** — BigQuery's job runtime
(`job.ended - job.started`) on the source side, ClickHouse
`X-ClickHouse-Summary.elapsed_ns` on the target side — so the
comparison is network-neutral. Wall-clock is also recorded as a
secondary diagnostic; the dashboard surfaces it under the primary
number when network RTT adds materially.

```python
from migrationkit import Benchmarker, BigQuerySource, ClickHouseTarget

Benchmarker(
    run_id="<run-id-from-step-2>",
    source=BigQuerySource.from_env(),
    target=ClickHouseTarget.from_env(),
    target_database="<target-db-from-step-1>",
).benchmark(queries=[
    {
        "name": "<short descriptive label>",
        "source_sql": "<original BigQuery SQL from step 4>",
        "target_sql": "<rewritten ClickHouse SQL from step 4>",
    },
    # ... one entry per query you rewrote in step 4 ...
])
```

What `benchmark(...)` does:

- Captures **server-side execution time** for `source_sql` on BigQuery
  and `target_sql` on ClickHouse Cloud (engine-reported, network-
  neutral); also records the wall-clock bracket for transparency.
- Persists per-query results into the `benchmarks` table and emits
  events the dashboard's **Benchmark** tab renders live (one row
  appears as each query finishes).
- A query that errors on one side captures the error in
  `source_error` / `target_error` and continues — one bad rewrite
  doesn't kill the run.
- Emits `step_benchmarked` at the end — that lights up the step-5
  checkmark. **Do not** also curl `/mark/benchmarked`.

## Dispatch + one tail

```text
1.  call: write_workspace_file(path="benchmark.py", content=<script above>)
2.  call: run_python_background(code=<read of benchmark.py>)    ← capture job_id
3.  call: tail_python_job(job_id=..., max_wait_seconds=120)
```

`max_wait_seconds=120` is the right starting point. If any query takes
longer than that on the source (e.g. scans a multi-GB partition range),
raise it.

Read the per-query summary from `stdout_delta`. Surface a one-paragraph
result in chat — headline numbers + any errors. For example: *"N
queries · avg speedup X× · max Y× on the heaviest one. One query hit
a parse error on the target — I'll fix that rewrite. Full per-query
timings are in the dashboard's **Benchmark** tab."*

If any query errored on the target side, fix the rewrite in chat,
**re-run the same `Benchmarker.benchmark(...)` script** (it overwrites
prior rows for the same run_id by `query_n`), and confirm the fix
landed. Then move on to step 6 (Optimize).
