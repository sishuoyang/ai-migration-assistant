## BigQuery Source — Migration Instructions

These rules apply when the data source is BigQuery. **The schema is
unknown ahead of time** — every connected project has different
datasets, tables, and BigQuery-specific objects. Discover the schema
dynamically before reasoning about migration.

---

## Identifier Case and Quoting

BigQuery is **case-sensitive on dataset and table names**; column names
are case-preserved but case-insensitive for comparison. The `mcp-toolbox`
tools return metadata using the names as they appear in BigQuery — use
those verbatim.

When writing SQL through `bigquery-execute-sql`, always **backtick-quote
fully-qualified table names** to avoid ambiguity:

```sql
-- WRONG: BigQuery treats unquoted dotted names as project.dataset.table
SELECT count(*) FROM my-project.<dataset>.<table>;

-- CORRECT
SELECT count(*) FROM `my-project.<dataset>.<table>`;
```

In the ClickHouse target schema, use lowercase by convention. Don't
carry BigQuery's mixed case into ClickHouse.

---

## Schema Discovery — Don't Assume Anything

Never assume column names, table names, types, or that any particular
BigQuery feature is or is not in use. Discover the actual schema at
runtime via the `bigquery-source` MCP.

**Use `bigquery-source` (not `migration-runner`) for all schema discovery
and read-only inspection of BigQuery.** The `migration-runner` MCP is
**only** for data movement (Path 1) once the schema is understood.
Reasons:

- `bigquery-source` is project-scoped — `bigquery-list-dataset-ids`
  returns every dataset the SA can read, not just one default.
- `migration-runner` inherits env vars from the playground's `.env` via
  `env_file:`. If a stale `BIGQUERY_DATASET` is set there from a
  previous workload, a `google-cloud-bigquery` connection through
  `migration-runner` will implicitly scope to that dataset and miss
  everything else.

**The discovery checklist for every BigQuery migration:**

1. **List datasets and tables:**
   - `bigquery-list-dataset-ids` — returns every dataset in the project
   - `bigquery-list-table-ids` — returns every table + view + MV in a
     dataset

2. **Get full schema per table** — `bigquery-get-table-info` returns
   types, partitioning info, clustering columns, row count, and byte
   size in one call. Prefer this over per-column `INFORMATION_SCHEMA`
   queries.

3. **Inspect partitioning + clustering** that `get-table-info` doesn't
   always surface in machine-readable form:
   ```sql
   SELECT table_name, partition_id, total_rows, total_logical_bytes
   FROM `<project>.<dataset>.INFORMATION_SCHEMA.PARTITIONS`
   WHERE table_name = '<table>';

   SELECT clustering_fields
   FROM `<project>.<dataset>.INFORMATION_SCHEMA.TABLES`
   WHERE table_name = '<table>';
   ```

4. **List materialised views and external tables**:
   ```sql
   SELECT table_name, table_type
   FROM `<project>.<dataset>.INFORMATION_SCHEMA.TABLES`
   WHERE table_type IN ('MATERIALIZED VIEW', 'EXTERNAL', 'VIEW');
   ```

5. **Sample data and check nullability + cardinality** for every column
   before designing the target. This tells you whether a column is
   `Nullable(T)`, whether a string is a `LowCardinality(String)`
   candidate, and whether a NUMERIC column needs full Decimal precision:
   ```sql
   SELECT * FROM `<project>.<dataset>.<table>` LIMIT 5;
   SELECT count(*), count(<col>) FROM `<project>.<dataset>.<table>`;
   SELECT count(DISTINCT <col>) FROM `<project>.<dataset>.<table>`;
   ```

6. **Inspect the query patterns** the partner shares. ORDER BY key
   selection on the ClickHouse side should come from the columns that
   appear in WHERE / JOIN / GROUP BY of the actual queries — not from
   the BigQuery clustering key alone.

Produce a migration inventory before generating any target schema.

> **Cost note.** BigQuery bills per byte scanned. `SELECT *` on a
> partitioned fact table scans every partition. For discovery, prefer
> `SELECT … LIMIT 5` (BigQuery still scans the table, but you can scope
> with WHERE on the partition column when you can) or
> `INFORMATION_SCHEMA.COLUMNS` (cheap metadata query).

---

## Looking Up BigQuery Documentation

When the agent encounters a BigQuery feature it doesn't fully understand
(`STRUCT` vs. `RECORD`, partitioned vs. ingestion-time partitioned tables,
materialised view refresh semantics, BigLake external tables, BigQuery
ML models, scheduled queries, authorised views, time travel, Capacitor
storage format, etc.), fetch the official docs via WebFetch:

```
WebFetch https://cloud.google.com/bigquery/docs/nested-repeated
WebFetch https://cloud.google.com/bigquery/docs/partitioned-tables
WebFetch https://cloud.google.com/bigquery/docs/clustered-tables
WebFetch https://cloud.google.com/bigquery/docs/materialized-views-intro
WebFetch https://cloud.google.com/bigquery/docs/biglake-intro
```

BigQuery docs don't serve a public `.md` endpoint the way Snowflake's
do, but the HTML pages WebFetch returns are readable enough for the
agent to extract the relevant semantics.

Cross-reference findings against the ClickHouse side via the
`clickhouse-docs` MCP (`search_click_house_documentation(...)`) to
identify the right ClickHouse equivalent — or to confirm there is none.

---

## Looking Up ClickHouse Best Practices

Always consult `clickhouse-docs` when designing the target schema. The
areas that benefit most from a docs lookup before committing to DDL:

- ORDER BY key selection
- PARTITION BY granularity (translating BigQuery `PARTITION BY
  DATE_TRUNC(col, MONTH)`)
- Decimal vs Float precision tradeoffs
- LowCardinality threshold
- Nullable vs sentinel-value choice
- Materialized View patterns (AggregatingMergeTree, SimpleAggregateFunction)
- `Tuple` vs `JSON` for `STRUCT` columns
- `Array(Tuple(...))` for `ARRAY<STRUCT<...>>` columns

The `clickhousectl` MCP also has the full best-practices reference
embedded in its server instructions — those rules are authoritative for
the target.

---

## Two Migration Paths — Always Ask First

Before generating any migration code, present both paths and let the
partner choose.

### Path 1 — Python via the `migration-runner` MCP

`google-cloud-bigquery` reads from the source; `clickhouse-connect`
writes to the target. The agent calls `run_python` on `migration-runner`
and streams output back into the chat. Use this when:
- Type coercion is non-trivial (STRUCT, ARRAY<STRUCT>, BIGNUMERIC, JSON)
- The partner wants a connector-pattern walkthrough

**Rule:** never paste Python into the chat for the partner to run
locally. Always invoke `run_python` and stream the output.

The migration-runner container sees these env vars: `BIGQUERY_PROJECT`,
`BIGQUERY_DATASET`, `BIGQUERY_LOCATION`,
`GOOGLE_APPLICATION_CREDENTIALS` (= `/secrets/gcp-key.json`),
`CLICKHOUSE_CLOUD_HOST`, `CLICKHOUSE_CLOUD_USER`,
`CLICKHOUSE_CLOUD_PASSWORD`, `CLICKHOUSE_CLOUD_DATABASE`.

Pre-installed libraries: `google-cloud-bigquery`, `db-dtypes`,
`clickhouse-connect`, `pyarrow`. Don't `pip install` anything inside
`run_python`; the runner user has no install permission.

**Two tools — pick the right one.**

| Tool | When to use |
|---|---|
| `run_python(code, timeout_seconds=3600)` | Synchronous, one tool call. Use ONLY for short scripts (<60 s) — schema checks, validation queries, small inserts. Output appears only when the script exits, so for anything longer the chat stays blank for the whole run. |
| `run_python_background(code, timeout_seconds=3600)` + `tail_python_job(job_id, max_wait_seconds=60)` | **Mandatory for actual data migrations.** Launches in the background, returns a `job_id` immediately. Dispatch the script, then issue **ONE** `tail_python_job` call to wait for completion or surface the first chunk of progress — then stop. The dashboard's Migration tab renders live per-table progress in real time; the partner watches it there, not in chat. |

**Background+tail pattern — dispatch + ONE tail + stop:**

```python
# 1. Launch the migration in the background
launch = run_python_background(code=migration_script, timeout_seconds=3600)
job_id = launch["job_id"]

# 2. ONE tail call — waits up to max_wait_seconds for the job to finish
#    (or returns a status=running snapshot if it's still going).
r = tail_python_job(job_id=job_id, max_wait_seconds=60)
# Then STOP. Do NOT loop tail_python_job — the dashboard streams progress.
# Surface a one-line summary in chat and point the partner to the dashboard.
```

**Do NOT poll in a `while True:` loop.** Each `tail_python_job` call replays
the full conversation context — repeated polling burns LLM tokens quadratically
for no benefit, since the dashboard's Migration tab already renders live
per-table row counts, throughput, and status. If the first tail returns
`status == "running"`, that's the signal to STOP, tell the partner *"migration
running — watch the Migration tab"*, and let them resume the conversation once
they see the run reach `done` in the dashboard.

**Timeout sizing.** Both `run_python` and `run_python_background`
default to 3600 s (1 h). For multi-million-row migrations, pass an
explicit `timeout_seconds` — roughly 1 second per ~5K rows is a safe
starting estimate when going BigQuery → ClickHouse Cloud over the
public internet.

**Resume on timeout.** If a script times out partway through, write a
**resume-aware** retry: check `count()` per target table in ClickHouse,
skip tables already at the expected row count, `TRUNCATE`
partially-loaded tables, and only re-run the unfinished ones. Never
blindly re-run the whole script — the dimensions are already done.

### Path 2 — Bulk export via GCS

ClickHouse Cloud reads Parquet from GCS via the `gcs()` table function.
Production-canonical for large workloads. Viable when:
- `STAGING_GCS_BUCKET` is set in the environment
- The SA has `roles/storage.objectAdmin` on the bucket
- BigQuery's `EXPORT DATA` statement is allowed in the project

Pattern (the agent generates and dispatches):

```sql
-- 1. Export the source table to GCS as Parquet.
EXPORT DATA OPTIONS(
    uri        = 'gs://${STAGING_GCS_BUCKET}/${STAGING_GCS_PREFIX}/<table>/*.parquet',
    format     = 'PARQUET',
    compression = 'SNAPPY',
    overwrite  = true
) AS
SELECT * FROM `${BIGQUERY_PROJECT}.${BIGQUERY_DATASET}.<table>`;
```

```sql
-- 2. On ClickHouse Cloud:
INSERT INTO <target_db>.<table>
SELECT * FROM gcs(
    'https://storage.googleapis.com/${STAGING_GCS_BUCKET}/${STAGING_GCS_PREFIX}/<table>/*.parquet',
    '<HMAC-access-key>', '<HMAC-secret>',
    'Parquet'
);
```

The `migrationkit` Python library wraps both steps as
`m.add_table_via_gcs(name=..., stage=GCSStage.from_env())`. Prefer the
library helper — it cleans up the staging prefix on success.

If GCS staging isn't configured, use Path 1.

---

## BigQuery → ClickHouse Type Mapping

Quick BigQuery-type → ClickHouse-type lookup. The ClickHouse
best-practices rules (already in this agent's prompt) cover the
type-choice nuances — LowCardinality threshold, Nullable avoidance, Enum
vs LowCardinality, Decimal vs Float, DateTime vs DateTime64 width, JSON
typed paths. Consult them when choosing the target type for a specific
column. The notes below are limited to **BigQuery-specific quirks**
that those rules don't cover.

| BigQuery | Default ClickHouse mapping | BigQuery-specific note |
|---|---|---|
| `STRING` | `String` (or `LowCardinality(String)` if cardinality is low) | BigQuery has no length limit; ignore any partner-imposed max length |
| `BYTES` | `String` / `FixedString(N)` | — |
| `INT64` | smallest `Int*` / `UInt*` that fits actual values | BigQuery doesn't distinguish integer widths; sample the actual max value |
| `NUMERIC(P, S)` (P ≤ 38, S ≤ 9) | `Decimal(P, S)` | Default precision is `NUMERIC(38, 9)` — verify actual usage before defaulting to `Decimal(38, 9)` |
| `BIGNUMERIC(P, S)` (P ≤ 76, S ≤ 38) | `Decimal128` / `Decimal256` | Rarely needed — confirm the data actually exceeds `NUMERIC` range |
| `FLOAT64` | `Float64` | — |
| `BOOL` | `Bool` | — |
| `DATE` | `Date` / `Date32` | — |
| `TIME` | `String` | ClickHouse has no native TIME |
| `DATETIME` | `DateTime` or `DateTime64(_)` | Naive local time, no timezone |
| `TIMESTAMP` | `DateTime64(_, 'UTC')` | BigQuery TIMESTAMP is timezone-naive in the type but always stores UTC under the hood. Default to `DateTime64(3, 'UTC')` |
| `GEOGRAPHY` | `String` (WKT) or `Point` / `Polygon` | No native CH GEOGRAPHY type; convert at the source with `ST_AsText(col)` and store as WKT |
| `INTERVAL` | `Int64` (microseconds since epoch difference) | No direct CH equivalent |
| `JSON` | `JSON` | Both engines have a typed JSON; use directly |
| `STRUCT<a INT64, b STRING>` | `Tuple(a Int64, b String)` OR `JSON` | Tuple is faster but less flexible if the partner adds fields later; JSON is more migration-friendly |
| `ARRAY<T>` (T scalar) | `Array(T)` | Direct mapping; BigQuery arrays cannot contain `NULL`, neither do ClickHouse `Array(T)` (use `Array(Nullable(T))` if needed) |
| `ARRAY<STRUCT<...>>` | `Array(Tuple(...))` OR `Array(JSON)` | The agent's choice — see decision criteria below |

For every column, run `SELECT count(*), count(<col>), count(DISTINCT
<col>)` before committing — the CH best-practices rules tell you what
to do with those numbers.

### `STRUCT` mapping decision

| Choose Tuple | Choose JSON |
|---|---|
| Field set is stable, well-known | Schema may evolve; new keys appear over time |
| Query patterns access named fields | Query patterns vary or extract dynamically |
| Field types are well-defined scalars | Some fields are themselves nested |
| Storage size matters (Tuple is much smaller) | Flexibility matters more than size |

### `ARRAY<STRUCT<...>>` mapping decision

Use `Array(Tuple(...))` when the inner field set is stable and queries
do typed access (`UNNEST` → `arrayJoin` + `t.field`). Use `Array(JSON)`
only if the inner structure varies row-to-row.

---

## BigQuery-Specific Objects — Migration Patterns

For each BigQuery-specific object discovered in the source schema, the
agent decides (a) recreate, (b) replace with a different mechanism, or
(c) defer / flag as out-of-scope. Document the decision in the final
report.

### Time-partitioned tables

BigQuery `PARTITION BY DATE(col)` / `DATE_TRUNC(col, MONTH)` /
`TIMESTAMP_TRUNC(col, HOUR)` etc. Translate to ClickHouse
`PARTITION BY` using the closest function on the same column:

| BigQuery partition | ClickHouse PARTITION BY |
|---|---|
| `DATE(col)`                                | `toDate(col)` (rarely useful — too many parts) |
| `DATE_TRUNC(col, MONTH)`                   | `toYYYYMM(col)` |
| `DATE_TRUNC(col, YEAR)` / `_YEAR(col)`     | `toYear(col)` |
| `TIMESTAMP_TRUNC(col, HOUR)`               | `toStartOfHour(col)` (rarely worth it) |
| Ingestion-time `_PARTITIONTIME`            | `toYYYYMM(_inserted_at)` after adding an explicit timestamp column |

Coarser is usually better. ClickHouse parts are heavier than BigQuery
partitions; aim for ~10–100 parts on a hot table, not thousands.

### Integer-range partitioned tables

Less common; translate to a hash-based partition (e.g.
`PARTITION BY intDiv(col, 1_000_000)`).

### Clustered tables

`CLUSTER BY col1, col2` is BigQuery's analogue to ClickHouse `ORDER BY`.
Translate directly:
- `CLUSTER BY user_id, event_date` → `ORDER BY (user_id, event_date)`
- Column order matters — BigQuery's primary cluster key prefix benefits
  from the same prefix-pruning behavior in ClickHouse, so preserve the
  order.

### Materialized views

BigQuery MVs auto-refresh on inserts to the source table — same trigger
semantics as ClickHouse MVs. Translate to a ClickHouse Materialized
View targeting an `AggregatingMergeTree` (GROUP BY / aggregate
workloads) or `SummingMergeTree` (simple sums).

**Always generate the `CREATE MATERIALIZED VIEW` AND the backfill
`INSERT` together** — creating the MV without backfilling leaves a gap
in historical data. (This rule comes from the base ClickHouse prompt
and applies here.)

Look up the BigQuery MV's refresh semantics before designing the CH
side — auto-refresh MVs that depend on partition pruning need explicit
ORDER BY on the partition key in CH.

### External tables (BigLake / Google Cloud Storage / BigTable / Drive)

ClickHouse has matching table functions for the common ones:
- BigLake on GCS Parquet → ClickHouse `gcs(...)` table function
- BigLake on S3 Parquet → ClickHouse `s3(...)` table function
- BigTable → no direct equivalent; flag as out-of-scope

For demos, the common pattern is "BigQuery reads Parquet from GCS via
BigLake — point ClickHouse Cloud at the same GCS path via `gcs()`."

### Scheduled queries

No equivalent in ClickHouse itself. Reimplement with an external
scheduler (Airflow, dbt, cron) that invokes the `clickhousectl` MCP or
runs the SQL via the ClickHouse Cloud HTTPS endpoint. Document the
schedule in the final report.

### Authorised views and authorised datasets

Recreate as ClickHouse row policies (`CREATE ROW POLICY`) or as
filtered views on the target. Inspect the view's SQL and convert to
ClickHouse syntax.

### BigQuery ML models

No ClickHouse equivalent for in-database ML. Out of scope; flag in the
report and recommend exporting the model + serving externally.

### Time Travel (BigQuery snapshot decorators)

BigQuery's `FOR SYSTEM_TIME AS OF` has no equivalent in ClickHouse.
Flag any reliance on Time Travel as a feature gap in the migration
report.

### Search indexes

Replace with appropriate ClickHouse skip indexes (`minmax`, `set`,
Bloom filter, `ngrambf_v1` for substring search). Inspect WHERE
clauses to pick the right index type.

### UDFs (SQL / JavaScript)

Rewrite SQL UDFs as ClickHouse SQL UDFs (`CREATE FUNCTION ... AS ...`).
For JavaScript UDFs, the options are: rewrite as SQL, embed in the
application layer, or compile a ClickHouse C++ UDF (high cost).

---

## Python Script Conventions

When generating Python for `migration-runner`, follow these rules.

**BigQuery connection** — `GOOGLE_APPLICATION_CREDENTIALS` is already
set in the container; the client picks it up automatically:

```python
import os
from google.cloud import bigquery

bq = bigquery.Client(
    project  = os.environ["BIGQUERY_PROJECT"],
    location = os.environ.get("BIGQUERY_LOCATION", "US"),
)
```

For batched reads, use `client.list_rows(table, page_size=…)` rather
than a `SELECT *` query — `list_rows` streams from BigQuery's storage
layer (cheaper and faster than running a query job):

```python
for row in bq.list_rows(f"{project}.{dataset}.<table>", page_size=50_000):
    ...  # row is a Row; access fields by name (lowercase): row["<col>"]
```

**ClickHouse Cloud connection** — same pattern as the snowflake rules:

```python
import clickhouse_connect
ch = clickhouse_connect.get_client(
    host     = os.environ["CLICKHOUSE_CLOUD_HOST"],
    port     = 8443,
    username = os.environ.get("CLICKHOUSE_CLOUD_USER", "default"),
    password = os.environ["CLICKHOUSE_CLOUD_PASSWORD"],
    database = os.environ["CLICKHOUSE_CLOUD_DATABASE"],
    secure   = True,
    verify   = False,
)
```

**STRUCT and ARRAY<STRUCT> handling.** BigQuery's row iterator returns
STRUCT columns as Python dicts and ARRAY columns as Python lists. For
ClickHouse, JSON columns want JSON strings, and `Tuple(...)` /
`Array(Tuple(...))` columns want tuples or lists of tuples in field
order. Convert in the transform step:

```python
import json

def transform_row(row):
    return {
        **row,
        # STRUCT → JSON column
        "<struct_col>": json.dumps(row["<struct_col>"]),
        # ARRAY<STRUCT> → Array(Tuple(...))
        "<array_struct_col>": [
            (a["<field_1>"], a["<field_2>"], a["<field_3>"])
            for a in (row["<array_struct_col>"] or [])
        ],
    }
```

**Always alias every function expression in SELECT.** Cursor row dicts
key by the SQL output name. `COALESCE(col, default)` produces key
`'COALESCE'`, not `'col'`. Every non-trivial expression needs an
explicit `AS alias` matching the target column name.

**Never duplicate column names** in the `column_names` list passed to
`client.insert`. If the target has a column the source does not, use a
SELECT alias — never repeat a name.

**Batch by date range or ID range** for tables over ~500k rows. Always
query the actual range first (`SELECT MIN, MAX, count(*)`) and generate
every batch in one script — never one batch at a time.

**Verify row counts at the end**: compare source `count(*)` against
target `count()` per table. Raise an exception if they don't match.

---

## Cost-aware querying

BigQuery bills per byte scanned. Several rules keep demo costs low:

1. **Use `INFORMATION_SCHEMA` for metadata, not data queries.** Schema
   discovery via `INFORMATION_SCHEMA.COLUMNS` or
   `INFORMATION_SCHEMA.TABLES` is essentially free.
2. **`SELECT *` scans every column** — for sampling, ask for the
   specific columns you need: `SELECT col1, col2 FROM tbl LIMIT 5`.
3. **WHERE on the partition column** when sampling a partitioned table.
   `SELECT * FROM <table> WHERE <partition_col> = '<value-in-one-partition>' LIMIT 5`
   scans one partition instead of the whole table — often two orders of
   magnitude cheaper.
4. **Use `bigquery-get-table-info`** for row counts and byte sizes —
   it returns table metadata without scanning any data.

Bytes scanned during a migration session shows up on the partner's
GCP bill — flag if the workload is large enough that this matters.
