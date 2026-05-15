# Step 5 — Benchmark source vs target

Time every analytical query on both engines. The dashboard's **Benchmark**
tab renders the comparison live. Use the queries from step 4 — those
that needed rewrites use the new SQL; the rest use the original.

## One script, one library call

Timing is **server-side** on both engines —
`X-ClickHouse-Summary.elapsed_ns` (the engine's own execution timer) is
read straight from each query's response, so the comparison is
network-neutral. Wall-clock is also captured as a secondary
diagnostic and surfaced in the dashboard when RTT adds materially.

```python
from migrationkit import Benchmarker, ClickHouseOssSource, ClickHouseTarget

Benchmarker(
    run_id="<run-id-from-step-2>",
    source=ClickHouseOssSource.from_env(),
    target=ClickHouseTarget.from_env(),
    target_database="<target-db-from-step-1>",
).benchmark(queries=[
    {
        "name": "<short descriptive label>",
        "source_sql": "<original SQL>",
        "target_sql": "<step-4 rewrite, or the original if no rewrite was needed>",
    },
    # ... one entry per query ...
])
```

What `benchmark(...)` does:

- Captures **server-side execution time** for `source_sql` on the OSS
  instance and `target_sql` on ClickHouse Cloud (both via
  `X-ClickHouse-Summary.elapsed_ns`); also records the wall-clock
  bracket for transparency.
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
query is slower than that on the source.

Surface a one-paragraph result in chat. For example: *"N queries · avg
speedup X× · max Y× on the heaviest one. Cloud's separated
compute / storage shows clearly on the GROUP-BY-heavy queries. Full
per-query timings in the **Benchmark** tab."*

Cloud often wins handily even against a well-tuned OSS instance —
separated compute / storage, automatic resource sizing, and Cloud's
default settings on a recent ClickHouse version. If anything regresses,
step 6 (Optimize) has the levers.

If any query errored on the target side, fix the rewrite in chat,
**re-run the same `Benchmarker.benchmark(...)` script** (it overwrites
prior rows for the same run_id by `query_n`), and confirm the fix
landed. Then move on to step 6.
