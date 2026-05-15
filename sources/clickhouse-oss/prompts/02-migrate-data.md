# Step 2 — Migrate data using `migrationkit`

The target schema from step 1 is in place. Copy the data from the
source ClickHouse OSS instance into the ClickHouse Cloud target
database using the `migrationkit` Python library — it handles
batching, per-batch checkpointing, pause/resume/cancel signals, and
live progress events the dashboard renders.

## Pick a path per table

| Path | Use when | API |
|---|---|---|
| **Direct** | `total_rows ≤ 1_000_000` | `m.add_table(...)` |
| **S3 staging** | `total_rows > 1_000_000` AND `STAGING_S3_BUCKET` is set | `m.add_table_via_s3(name=..., stage=S3Stage.from_env())` |

S3 staging uses ClickHouse's native `INSERT INTO FUNCTION s3()` on the
source side and `INSERT FROM s3()` on the target — the wire path is
cloud-to-cloud the whole way, typically **5–10× faster** end-to-end on
the largest tables. Check for it up front:

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
from migrationkit import Migrator, ClickHouseOssSource, ClickHouseTarget, S3Stage

USE_S3 = bool(os.environ.get("STAGING_S3_BUCKET"))
stage = S3Stage.from_env() if USE_S3 else None

m = Migrator(
    run_id=f"migrate-<source-db-from-step-1>-{int(time.time())}",
    source=ClickHouseOssSource.from_env(),
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
    # transform=lambda row: {...}   # only if you need per-row conversion
)

# S3-staged path: large tables, only when stage is set.
if stage is not None:
    m.add_table_via_s3(name="<fact_table>", target_table="<fact_table>", stage=stage)
else:
    m.add_table(name="<fact_table>", source_query="SELECT * FROM <fact_table>",
                target_table="<fact_table>", batch_size=100_000)

# … one m.add_table(...) or m.add_table_via_s3(...) per source table.

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
  ~25k for wide tables. Avoid > 500k.
- **Row dict keys are lowercase** — `clickhouse-connect` returns
  lowercase column names. Reference fields in lowercase in any
  `transform=` lambda.
- For `Map(String, String)` columns: pass the Python dict through
  unchanged — the target accepts the same shape.
- For `Array(Tuple(...))` columns: pass a list of tuples in field
  order; the source iterator hands them back this way.
- **Skip `AggregatingMergeTree` source tables.** Their data is stored
  in aggregate states tied to the source's storage layout; copy the
  raw underlying tables instead, then recreate the MV + backfill on
  Cloud as part of step 6 (Optimize). Flag this in chat so the
  partner knows the rollup will be rebuilt.
- The Migrator pre-flights every plan against the target database
  before any rows move; missing tables fail loudly at registration
  time, not mid-batch.
- S3 staging supports neither `batch_size` nor `transform` — the
  library does `INSERT INTO FUNCTION s3()` → `INSERT FROM s3()`. For
  per-row transformation, fall back to the direct path.
- If `S3Stage.from_env()` raises a missing-env error, tell the partner
  to either set `STAGING_S3_*` (see `docs/object-storage-staging.md`)
  or accept the direct path.

After the single confirming `tail_python_job` call, tell the partner
the migration is **running** (not "complete") and that the dashboard
tracks progress. Step 3 (Validate) will run when the partner clicks it.
