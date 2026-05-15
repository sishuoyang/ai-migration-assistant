# Step 3 — Validate the migration

Confirm the data landed in ClickHouse Cloud correctly. Use the run from
step 2 and the target database from step 1 — do not introduce new names.

## One script, one library call

```python
from migrationkit import Validator, PostgresSource, ClickHouseTarget

Validator(
    run_id="<run-id-from-step-2>",
    source=PostgresSource.from_env(),
    target=ClickHouseTarget.from_env(),
    target_database="<target-db-from-step-1>",
).validate()
```

What that does:

- Pulls the table list from the run's `run_tables` (the same tables
  step 2 migrated — you don't repeat them here).
- For each table runs `SELECT count(*)` on both sides, decides
  matched / mismatched, prints a one-line summary.
- Writes per-table results into the `validations` table; events feed
  the dashboard's **Validation** tab in real time.
- Emits `step_validated` — lights up the step-3 checkmark.

## Dispatch + one tail

```text
1.  call: write_workspace_file(path="validate.py", content=<script above>)
2.  call: run_python_background(code=<read of validate.py>)     ← capture job_id
3.  call: tail_python_job(job_id=..., max_wait_seconds=60)      ← waits for done
```

Surface a one-line result in chat — e.g. *"all tables matched"* or
*"one table mismatched — source and target row counts differ;
investigate before continuing."* Then point the partner to the
**Validation** tab for the full table.

If any table mismatched or errored, **stop here**. Report the mismatch
in chat — table name, source rows, target rows — and let the partner
decide. Re-running step 2 with a fixed schema is usually the right
call.

**Do NOT attempt to repair the target out-of-band** — no manual
`INSERT INTO … SELECT * FROM …`, no `clickhousectl` patch-up calls,
no "let me just re-insert the missing rows" loops. The Migrator
script from step 2 is the source of truth for what lands in the
target; bypassing it on a mismatch hides the underlying bug, risks
duplicate inserts, and burns through tool-call budget for no
durable fix. Surface the mismatch and stop.
