# Step 2 — Migrate data using `migrationkit`

The target schema from step 1 is in place. Copy the data from the
source database into the ClickHouse Cloud target using the
`migrationkit` Python library — it handles batching, per-batch
checkpointing, pause/resume/cancel signals, and the live progress
events the dashboard renders.

## Pick a path per table

| Path | Use when | API |
|---|---|---|
| **Direct** | `total_rows ≤ 1_000_000` | `m.add_table(...)` |
| **S3 staging** | `total_rows > 1_000_000` AND `STAGING_S3_BUCKET` is set | `m.add_table_via_s3(name=..., stage=S3Stage.from_env())` |

Check for S3 staging up front:

```python
import os
USE_S3 = bool(os.environ.get("STAGING_S3_BUCKET"))
```

If `USE_S3` is False, fall back to the direct path for every table
(with a one-line chat note that the partner hasn't configured S3
staging). Don't fail the migration — direct works for any size, it's
just slower.

## What to write

Generate one Python script (~25 lines), dispatch it with
`run_python_background`, and confirm it started with one
`tail_python_job` call.

```python
import os
import time
from migrationkit import Migrator, SnowflakeSource, ClickHouseTarget, S3Stage

USE_S3 = bool(os.environ.get("STAGING_S3_BUCKET"))
stage = S3Stage.from_env() if USE_S3 else None

m = Migrator(
    run_id=f"migrate-<source-db-from-step-1>-{int(time.time())}",
    source=SnowflakeSource.from_env(),
    target=ClickHouseTarget.from_env(),
    # REQUIRED: name of the ClickHouse Cloud database from step 1.
    target_database="<target-db-from-step-1>",
)

# Direct path: small + medium tables. `target_table` is a BARE name —
# never `db.table`; the Migrator owns the database via target_database=.
m.add_table(
    name="<dim_table>",
    source_query="SELECT * FROM <dim_table>",
    target_table="<dim_table>",
    batch_size=100_000,
)

# S3-staged path: large tables, only when stage is set.
if stage is not None:
    m.add_table_via_s3(name="<fact_table>", target_table="<fact_table>", stage=stage)
else:
    m.add_table(name="<fact_table>", source_query="SELECT * FROM <fact_table>",
                target_table="<fact_table>", batch_size=100_000)

# … one m.add_table(...) or m.add_table_via_s3(...) per source table.

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
  ~25k for wide tables with VARIANT columns. Avoid > 500k.
- **Row dict keys are lowercase** — Snowflake's connector returns
  uppercase metadata but the iterator lowercases column names. Write
  any `transform=` lambda in lowercase.
- Snowflake VARIANT / OBJECT values arrive as Python dicts / lists.
  Wrap with `json.dumps(...)` if the target column is `String`; pass
  through unchanged if the target column is `JSON`.
- S3 staging supports neither `batch_size` nor `transform` — the
  library does `COPY INTO @stage` → `INSERT FROM s3()`. For per-row
  transformation, fall back to the direct path.
- If `S3Stage.from_env()` raises a missing-env error, tell the partner
  to either set `STAGING_S3_*` (see `docs/object-storage-staging.md`)
  or accept the direct path.

## When you're done

Surface the strategy choice for each table (e.g. *"large fact tables on
the S3 path, others direct"*), tell the partner the migration is
**running** (not "complete"), and point at the dashboard. Step 3
(Validate) runs when the partner clicks it.
