# Step 1 — Discover the source and design the ClickHouse Cloud target schema

You are migrating from `{source}` to ClickHouse Cloud.

- **Source dataset** (where the data lives today): `{database}` — this
  is the partner's selection from the dashboard. Use it as-is.
- **Target database** (where the data will land in ClickHouse Cloud):
  not chosen yet. Propose a name in this step and confirm with the
  partner in chat.

If the partner has explicitly told you in this conversation to use a
different source dataset, follow their chat instruction instead.

## Source

Use the `{source}-source` MCP to:

1. List the tables in `{database}` with `bigquery-list-table-ids`. For
   each, get row count + byte size via `bigquery-get-table-info`.
2. For each table, fetch the column list with types and any
   BigQuery-specific features (`STRUCT` / `RECORD` columns, `ARRAY`
   columns, `TIMESTAMP` vs. `DATETIME`, partitioning, clustering,
   materialised views). Use `bigquery-get-table-info` (preferred — single
   call, returns the full schema) and fall back to
   `INFORMATION_SCHEMA.COLUMNS` / `INFORMATION_SCHEMA.PARTITIONS` via
   `bigquery-execute-sql` for partition / cluster detail when needed.
3. Identify fact and dimension tables and their relationships — use
   column-name conventions, JOIN patterns from the partner's analytical
   workload, and explicit `FOREIGN KEY` constraints in
   `INFORMATION_SCHEMA.KEY_COLUMN_USAGE` where present.

## Analytical workload

The partner will run these queries against the migrated data. Use them to
choose `ORDER BY` keys, partition keys, and projection candidates:

```sql
{olap_queries}
```

## Target

Use the `clickhousectl` MCP to:

1. Create the target database (suggested default `migration_demo`;
   confirm with the partner first).
2. Issue `CREATE TABLE` statements for every source table. Follow the
   ClickHouse Cloud best-practice rules attached to **clickhousectl**
   for engine, `ORDER BY`, `PARTITION BY`, and codec choices — justify
   each in chat. If a source table has `CLUSTER BY`, that's a strong
   starting hint for the target's `ORDER BY`.
3. Map source-specific types:
   - BigQuery STRUCT → `JSON` (or `Tuple(...)`)
   - BigQuery ARRAY → `Array(T)` or `Array(Tuple(...))`
   - BigQuery TIMESTAMP → `DateTime64(_, 'UTC')`
   - BigQuery NUMERIC → `Decimal(P, S)`
   - BigQuery INT64 → the smallest `Int*` / `UInt*` that fits the
     actual value range
4. **Handle nullable source columns deliberately.** BigQuery columns
   are `NULLABLE` unless declared `REQUIRED` (or `REPEATED` for arrays);
   `INFORMATION_SCHEMA.COLUMNS` exposes the mode. For each nullable
   source column either:
   - Declare the target column as `Nullable(<T>)`, **or**
   - Declare non-Nullable with an explicit `DEFAULT` (e.g. `String
     DEFAULT ''`, `Int64 DEFAULT 0`) AND add a `transform=` lambda in
     step 2 that maps `None` → the same default before insert.
   Never leave a non-Nullable target column without either of those —
   the migration will fail mid-batch when the first NULL arrives.
5. Verify with `SHOW TABLES`.

## When you're done

Summarise the source dataset name, target database name, and key schema
choices in chat. Subsequent steps refer back to these. Do **not** insert
any data — that's step 2.
