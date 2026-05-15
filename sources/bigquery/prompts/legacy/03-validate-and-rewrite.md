# Step 3 — Validate the migration and rewrite the analytical queries

Now confirm the data landed correctly and adapt the partner's analytical
queries to ClickHouse SQL. Use the source and target databases from
steps 1 and 2 — do not introduce new names.

## Validation — one script, one library call

The migrationkit library handles row-count validation end-to-end:

```python
from migrationkit import Validator, BigQuerySource, ClickHouseTarget

Validator(
    run_id="<run-id-from-step-2>",
    source=BigQuerySource.from_env(),
    target=ClickHouseTarget.from_env(),
    target_database="<target-db-from-step-1>",
).validate()
```

What that does:

- Pulls the table list from the run's `run_tables` (the same tables
  step 2 migrated — you don't need to repeat them here).
- For each table runs `SELECT count(*)` on both sides, captures the
  numbers, decides matched/mismatched, prints a one-line summary.
- Writes per-table results into the `validations` table and emits
  events the dashboard's **Validation** tab renders in real time.
- Emits `step_validated` at the end — that lights up the step-3
  checkmark in the dashboard. **Do not** also `curl POST /mark/validated`;
  the library does it.

Dispatch + one tail to wait for completion:

```text
1.  call: write_workspace_file(path="validate.py", content=<script above>)
2.  call: run_python_background(code=<read of validate.py>)     ← capture job_id
3.  call: tail_python_job(job_id=..., max_wait_seconds=60)      ← waits for done
```

Read the per-table summary from `stdout_delta`. Surface a one-line
result in chat — e.g. *"✓ all 8 tables matched"* or *"✗ orders
mismatched: source 1.5M, target 1.49M — investigate."* Then tell the
partner: *"Open the **Validation** tab in the dashboard for the full
table."* No need to paste the comparison into chat — the dashboard
renders it better.

If any table mismatched or errored, **stop** here and tell the
partner before attempting the rewrite step below — re-running step 2
may be needed first.

---

## Rewrite the analytical queries — in chat, no tool calls

The partner's current query set is below. (The dashboard's Analytical
Queries dialog is the source of truth — if the partner edited the
queries since step 1, the new set is what you see here.)

```sql
{olap_queries}
```

Translate each query to ClickHouse SQL **in chat** (this is pure
reasoning; no tool calls required for the rewrite itself). Helpful
mappings:

- `CURRENT_TIMESTAMP()` → `now()`
- `DATE_TRUNC(col, MONTH)` → `toStartOfMonth(col)`
- `EXTRACT(YEAR FROM col)` → `toYear(col)`
- `ARRAY_AGG(x)` → `groupArray(x)`
- STRUCT field access `t.col.field` → `t.col.field` (still works on
  `Tuple(...)`) or `JSONExtractString(col, 'field')` if the target
  column is `JSON`
- ARRAY field access `t.col[OFFSET(0)].field` → `t.col[1].field`
  (ClickHouse arrays are 1-indexed)
- `UNNEST(arr)` → `arrayJoin(arr)`
- `SAFE_CAST` → `accurateCastOrNull` or `toX(col)` with explicit
  null-handling
- `IFNULL` / `COALESCE` → `ifNull` / `coalesce`

Surface each rewritten query in chat so the partner can see what you
changed. **Don't** verify them by running here — step 4's `Benchmarker`
runs every rewritten query against the target as part of the timing
comparison and surfaces any parse / runtime errors in the dashboard's
Benchmark tab. That's where verification lives.

---

## When you're done

After the validation script returns and you've shared the rewritten
queries in chat, tell the partner:

1. Whether row counts matched (and what to do if any didn't).
2. The rewritten queries are ready; step 4 will benchmark and verify
   them in one pass.

The dashboard's step-3 checkmark lights up automatically when
`Validator.validate()` completes — no curl required.

---

## Tool-call budget

Total step 3 should be ≈ 3 tool calls:

1. `write_workspace_file(path="validate.py", content=...)`
2. `run_python_background(code=read of validate.py)` → job_id
3. `tail_python_job(job_id, max_wait_seconds=60)` — read summary

The rewrites are pure chat; no tool calls. If you find yourself making
more, you're either polling the tail (don't) or re-deriving validation
logic the library already provides (use `Validator`).
