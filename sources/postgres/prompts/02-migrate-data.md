# Step 2 — Migrate data using `migrationkit`

The target schema from step 1 is in place. Copy the data from the source
Postgres database into the ClickHouse Cloud target database using the
`migrationkit` Python library — it handles batching, per-batch
checkpointing, pause/resume/cancel signals, and live progress events
the dashboard renders.

## What to write

Generate a small Python script (~25 lines), dispatch it with
`run_python_background`, and confirm it started with one
`tail_python_job` call.

Skeleton:

```python
import time
from migrationkit import Migrator, PostgresSource, ClickHouseTarget

m = Migrator(
    run_id=f"migrate-<source-db-from-step-1>-{int(time.time())}",
    source=PostgresSource.from_env(),
    target=ClickHouseTarget.from_env(),
    # REQUIRED: name of the ClickHouse Cloud database from step 1.
    target_database="<target-db-from-step-1>",
)

# One m.add_table(...) per source table. `target_table` is a BARE
# name — never `db.table`; the Migrator owns the database via
# target_database= above.
m.add_table(
    name="<table>",
    source_query="SELECT * FROM <table>",
    target_table="<table>",
    batch_size=100_000,
    # transform=lambda row: {...}   # only if you need per-row conversion
)
# … add one m.add_table(...) per source table.

m.run()  # blocks (inside run_python_background) until done
```

Chat-side flow:

```text
1.  call: write_workspace_file(path="migrate.py", content=<script above>)
2.  call: run_python_background(code=<read of migrate.py>)     ← capture job_id
3.  call: tail_python_job(job_id=..., max_wait_seconds=5)      ← ONE call, confirm status=running
4.  reply in chat: "Migration <run_id> is running — watch the dashboard."
```

That's it. **No polling loop.** The dashboard handles the rest.

## Rules

- Always pass `target_database=` to `Migrator(...)` and use bare names
  in `target_table`. Qualified `db.table` names raise `ValueError` at
  registration.
- Pick `batch_size` proportional to row width: ~100k for narrow tables,
  ~25k for wide tables with JSONB / ARRAY columns. Avoid > 500k.
- **Row dict keys are lowercase** — Postgres returns lowercase columns
  from `psycopg2`'s `RealDictCursor`. Reference fields in lowercase in
  any `transform=` lambda.
- For JSONB columns: the row value is already a Python dict / list
  (`psycopg2` deserialises it). Wrap with `json.dumps(...)` if the
  target column is typed `String`:

  ```python
  transform=lambda row: {**row, "<jsonb_col>": json.dumps(row["<jsonb_col>"])}
  ```

  If the target column is typed `JSON`, you can pass the dict
  through unchanged — `clickhouse-connect` serialises it for you.
- For ARRAY columns: pass the Python list through unchanged. If the
  source has `ARRAY` of composite types, convert each element to a
  tuple in the target column's field order before insert.
- The Migrator pre-flights every plan against the target database
  before any rows move; missing tables fail loudly at registration
  time, not mid-batch.

After the single confirming `tail_python_job` call, tell the partner
the migration is **running** (not "complete") and that the dashboard
tracks progress. Step 3 (Validate) will run when the partner clicks it.
