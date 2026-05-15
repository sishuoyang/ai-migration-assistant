## ClickHouse OSS → ClickHouse Cloud Migration

---

### Schema Discovery — Use `clickhouse-oss-source`, Not `migration-runner`

For ALL schema discovery and read-only inspection of the OSS instance,
issue SQL via the `clickhouse-oss-source` MCP. The `migration-runner`
MCP is **only** for data movement once the schema is understood.

Why this matters: `clickhouse-oss-source` returns rows directly in the
chat (one tool-call block per query — visible to the partner). Driving
the same queries through `migration-runner` means authoring a Python
script per inspection — five `run_python` round-trips for what should
be five MCP calls, with output the partner can't see until each script
exits.

**Discovery checklist for every CH OSS migration** — each step is one
query via `clickhouse-oss-source`:

1. **Databases + tables with row counts and bytes**:
   ```sql
   SELECT database, name, engine,
          total_rows, total_bytes
   FROM system.tables
   WHERE database NOT IN ('system','INFORMATION_SCHEMA','information_schema')
   ORDER BY total_bytes DESC;
   ```

2. **Full DDL** for each object — preserves PARTITION BY, ORDER BY,
   TTL, codecs, projections:
   ```sql
   SHOW CREATE TABLE <database>.<table>;
   ```

3. **Per-column types + nullability + cardinality estimate** (whether
   a column is `LowCardinality(String)` candidate, needs Decimal):
   ```sql
   DESCRIBE TABLE <database>.<table>;
   SELECT count(), uniq(<col>) FROM <database>.<table>;
   ```

4. **AggregatingMergeTree / MaterializedView inventory** (these need
   the recreate-and-backfill pattern below, not a straight copy):
   ```sql
   SELECT database, name, engine
   FROM system.tables
   WHERE engine LIKE '%AggregatingMergeTree%'
      OR engine = 'MaterializedView';
   ```

5. **Projections + skip indexes** (cheap to recreate on the target,
   but easy to forget):
   ```sql
   SELECT * FROM system.projection_parts
   WHERE database = '<db>' AND table = '<table>' LIMIT 5;

   SELECT * FROM system.data_skipping_indices
   WHERE database = '<db>' AND table = '<table>';
   ```

Do not reach for `run_python` on `migration-runner` until step 2 (data
movement) — discovery stays on `clickhouse-oss-source`.

---

This section applies when the SOURCE database is ClickHouse OSS (self-managed).

---

### AggregatingMergeTree — Do Not Copy Binary State Columns

Tables using `AggregatingMergeTree` store pre-computed aggregation states in binary
format (e.g., `AggregateFunction(uniq, UInt64)` for HyperLogLog sketches).
These binary blobs are version-specific and instance-specific — `SELECT *` from
an AggregatingMergeTree produces raw binary that **cannot be inserted into another
instance** via a Python script or `remoteSecure()`.

**Rule:** Never attempt to migrate AggregatingMergeTree tables by copying rows.
Instead, apply this three-step pattern every time:

```sql
-- Step 1: Create the target AggregatingMergeTree table in CHC
CREATE TABLE IF NOT EXISTS <db>.<agg_table>
( ... same schema ... )
ENGINE = AggregatingMergeTree()
PARTITION BY ...
ORDER BY (...);

-- Step 2: Create the Materialized View (captures future inserts)
CREATE MATERIALIZED VIEW IF NOT EXISTS <db>.<mv_name>
TO <db>.<agg_table>
AS SELECT ... uniqState(<col>) AS <col>, ... FROM <db>.<source_table>
GROUP BY ...;

-- Step 3: Backfill from already-migrated source data
INSERT INTO <db>.<agg_table>
SELECT ... uniqState(<col>) AS <col>, ... FROM <db>.<source_table>
GROUP BY ...;
```

The SELECT in the backfill (Step 3) must be **identical** to the SELECT in the
Materialized View definition (Step 2). Always output all three steps together.

---

### Querying AggregatingMergeTree in ClickHouse Cloud

After migration, reading from the aggregated table requires merge functions:

| Aggregate state type | Read with |
|---|---|
| `AggregateFunction(uniq, T)` | `uniqMerge(<col>)` |
| `AggregateFunction(avg, T)` | `avgMerge(<col>)` |
| `AggregateFunction(quantile(0.5), T)` | `quantileMerge(0.5)(<col>)` |
| `SimpleAggregateFunction(sum, T)` | `sum(<col>)` (no Merge needed) |

`SimpleAggregateFunction` columns (sum, min, max) can be read with plain
aggregation — no merge function required.

Example for a rollup table with mixed aggregate column types:
```sql
SELECT
    <bucket_col>,
    uniqMerge(<aggfunc_col>)        AS unique_count,    -- AggregateFunction(uniq, …)
    sum(<simple_agg_col>)           AS total,           -- SimpleAggregateFunction(sum, …)
    sum(<plain_col>)                AS sum_plain        -- plain numeric column
FROM <target_db>.<rollup_table>
GROUP BY <bucket_col>
ORDER BY <bucket_col>;
```

---

### Map Column Migration

`Map(String, String)` columns migrate transparently — no type coercion needed.
In the target schema, keep the same `Map(String, String)` type.

Map key access in CHC uses the same syntax as OSS:
```sql
-- Both OSS and Cloud: returns '' (not NULL) when key is absent
properties['ab_variant']
-- Equivalent explicit syntax:
properties['ab_variant'] = ''   -- tests for missing/empty key
mapContains(properties, 'ab_variant')  -- tests presence
```

---

### Migration Script — ClickHouse OSS Source

When generating or reviewing a Python migration script for a ClickHouse OSS
source, apply these rules:

**Connections:**
- OSS source: `secure=False`, HTTP port 8123
- CHC target: `secure=True`, `verify=False` (macOS TLS chain fix), HTTPS port 8443

**Environment variables (match `.env` naming exactly):**
- Source (ClickHouse OSS): `CH_OSS_HOST`, `CH_OSS_PORT`, `CH_OSS_USER`, `CH_OSS_PASSWORD`, `CH_OSS_DB`
- Target (ClickHouse Cloud): `CLICKHOUSE_CLOUD_HOST`, `CLICKHOUSE_CLOUD_PORT`, `CLICKHOUSE_CLOUD_USER`,
  `CLICKHOUSE_CLOUD_PASSWORD`, `CLICKHOUSE_CLOUD_DATABASE`

```python
# OSS source
CH_OSS_HOST     = os.getenv("CH_OSS_HOST", "localhost")
CH_OSS_PORT     = int(os.getenv("CH_OSS_PORT", "8123"))
CH_OSS_USER     = os.getenv("CH_OSS_USER", "default")
CH_OSS_PASSWORD = os.getenv("CH_OSS_PASSWORD", "")
CH_OSS_DB       = os.getenv("CH_OSS_DB", "analytics")

# ClickHouse Cloud target
CH_HOST     = os.environ["CLICKHOUSE_CLOUD_HOST"]
CH_PORT     = int(os.getenv("CLICKHOUSE_CLOUD_PORT", "8443"))
CH_USER     = os.environ.get("CLICKHOUSE_CLOUD_USER", "default")
CH_PASSWORD = os.environ["CLICKHOUSE_CLOUD_PASSWORD"]
CH_DB       = os.environ["CLICKHOUSE_CLOUD_DATABASE"]
```

**Column names:** ClickHouse column names come back correctly from `result.column_names`
— no alias mapping needed (unlike psycopg2 DictCursor).

**AggregatingMergeTree tables:** Exclude them from the TABLES list. Document the
three-step recreate+backfill in the script's output or as a post-migration note.

---

### Partition and ORDER BY Key Preservation

When recreating the schema in CHC, preserve the source partition and ORDER BY
keys unless there is a clear reason to change them. Changing ORDER BY after data
is loaded requires a full rewrite.

If the migration workload analysis reveals a better ORDER BY (e.g., a different
leading key for the primary queries), document the tradeoff:
- New key improves query X by Y%
- Existing data must be re-inserted in the new key order (not an ALTER)
- Suggest the change but let the partner decide before generating DDL

---

### LowCardinality Columns

LowCardinality dictionaries are local to each ClickHouse instance and are rebuilt
automatically from the data as it is inserted. No special handling is needed —
keep `LowCardinality(String)` in the target schema and insert normally.
