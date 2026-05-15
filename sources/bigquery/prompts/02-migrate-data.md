# Step 2 — Migrate data using `migrationkit`

The target schema from step 1 is in place. Copy the data from the
BigQuery source dataset into the ClickHouse Cloud target using the
`migrationkit` Python library — it handles batching, per-batch
checkpointing, pause/resume/cancel signals, and the live progress
events the dashboard renders.

## Pick a path per table

| Path | Use when | API |
|---|---|---|
| **Direct** | `total_rows ≤ 1_000_000` | `m.add_table(...)` |
| **GCS staging** | `total_rows > 1_000_000` AND `STAGING_GCS_BUCKET` is set | `m.add_table_via_gcs(name=..., stage=GCSStage.from_env())` |

Check for GCS staging up front:

```python
import os
USE_GCS = bool(os.environ.get("STAGING_GCS_BUCKET"))
```

If `USE_GCS` is False, fall back to the direct path for every table
(with a one-line chat note that the partner hasn't configured GCS
staging). Don't fail the migration.

## What to write

Generate one Python script (~25 lines), dispatch it with
`run_python_background`, and confirm it started with one
`tail_python_job` call.

```python
import os
import time
from migrationkit import Migrator, BigQuerySource, ClickHouseTarget, GCSStage

USE_GCS = bool(os.environ.get("STAGING_GCS_BUCKET"))
stage = GCSStage.from_env() if USE_GCS else None

m = Migrator(
    run_id=f"migrate-<source-db-from-step-1>-{int(time.time())}",
    source=BigQuerySource.from_env(),
    target=ClickHouseTarget.from_env(),
    target_database="<target-db-from-step-1>",
)
# Bare table names below — never `db.table`; the Migrator owns the
# database via target_database= above.

m.add_table(
    name="<dim_table>",
    source_query="SELECT * FROM <dim_table>",
    target_table="<dim_table>",
    batch_size=100_000,
)

if stage is not None:
    m.add_table_via_gcs(name="<fact_table>", target_table="<fact_table>", stage=stage)
else:
    m.add_table(name="<fact_table>", source_query="SELECT * FROM <fact_table>",
                target_table="<fact_table>", batch_size=100_000)

# … one m.add_table(...) or m.add_table_via_gcs(...) per source table.

m.run()
```

Chat-side flow:

```text
1.  call: write_workspace_file(path="migrate.py", content=<script above>)
2.  call: run_python_background(code=<read of migrate.py>)     ← capture job_id
3.  call: tail_python_job(job_id=..., max_wait_seconds=5)      ← ONE call, confirm status=running
4.  reply in chat: "Migration <run_id> is running — watch the dashboard."
```

**No polling loop after that.** The dashboard streams progress.

## Rules

- Always pass `target_database=` to `Migrator(...)` and use bare names
  in `target_table`. Qualified `db.table` raises `ValueError` at
  registration.
- Pick `batch_size` proportional to row width: ~100k for narrow tables,
  ~25k for wide tables with `STRUCT` / `ARRAY` columns. Avoid > 500k.
- **Row dict keys are lowercase** — the BigQuery iterator returns
  lowercase column names. Write any `transform=` lambda in lowercase.
- BigQuery `STRUCT` / `RECORD` values arrive as Python dicts. Wrap
  with `json.dumps(...)` if the target column is `String`; pass
  through unchanged if the target column is `JSON`.
- BigQuery `ARRAY<STRUCT<...>>` values arrive as lists of dicts. If
  the target column is `Array(Tuple(...))`, convert each dict to a
  tuple in field order before insert:

  ```python
  transform=lambda row: {
      **row,
      "<array_struct_col>": [
          (a["<field_1>"], a["<field_2>"], a["<field_3>"])
          for a in (row["<array_struct_col>"] or [])
      ],
  }
  ```

- GCS staging supports neither `batch_size` nor `transform` — the
  library does `EXPORT DATA OPTIONS(format='PARQUET')` → `INSERT FROM
  gcs(...)`. For per-row transformation, fall back to the direct path.
- If `GCSStage.from_env()` raises a missing-env error, tell the
  partner to either set `STAGING_GCS_*` (see
  `docs/object-storage-staging.md`) or accept the direct path.

## When you're done

Surface the strategy choice for each table (e.g. *"large fact tables on
the GCS path, others direct"*), tell the partner the migration is
**running** (not "complete"), and point at the dashboard. Step 3
(Validate) runs when the partner clicks it.
