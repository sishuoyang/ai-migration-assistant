# Step 1 — Discover the source and design the ClickHouse Cloud target schema

You are migrating from `{source}` to ClickHouse Cloud.

- **Source database** (where the data lives today): `{database}` — this
  is the partner's selection from the dashboard. Use it as-is.
- **Target database** (where the data will land in ClickHouse Cloud):
  not chosen yet. Propose a name in this step and confirm with the
  partner in chat.

If the partner has explicitly told you in this conversation to use a
different source database, follow their chat instruction instead.

## Source

Use the `{source}-source` MCP to:

1. List the tables in `{database}` (their names, row counts, byte sizes).
2. For each table, fetch the column list with types and any source-specific
   features (VARIANT / OBJECT, TIMESTAMP_TZ, CLUSTER BY keys, dynamic tables,
   streams, etc.). If the MCP exposes a bulk schema-describe tool, prefer
   that over per-table calls.
3. Identify the fact + dimension tables and their relationships.

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
   each in chat.
3. Map source-specific types:
   - Snowflake VARIANT / OBJECT → `JSON` (or `String` if you need
     parse-on-read flexibility)
   - Snowflake TIMESTAMP_TZ → `DateTime64(_, 'UTC')`
   - Snowflake NUMBER(P, S) → `Decimal(P, S)`
4. **Handle nullable source columns deliberately.** Snowflake reports
   nullability in `INFORMATION_SCHEMA.COLUMNS` (`IS_NULLABLE`); columns
   marked nullable can carry NULLs in practice. For each such column
   either:
   - Declare the target column as `Nullable(<T>)`, **or**
   - Declare non-Nullable with an explicit `DEFAULT` (e.g. `String
     DEFAULT ''`, `Int64 DEFAULT 0`) AND add a `transform=` lambda in
     step 2 that maps `None` → the same default before insert.
   Never leave a non-Nullable target column without either of those —
   the migration will fail mid-batch when the first NULL arrives.
5. Verify with `SHOW TABLES`.

## When you're done

Summarise the source database name, target database name, and key schema
choices in chat. Subsequent steps refer back to these. Do **not** insert
any data — that's step 2.
