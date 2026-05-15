# Step 1 — Discover the source and design the ClickHouse Cloud target schema

You are migrating from `{source}` to ClickHouse Cloud.

- **Source database**: `{database}` — the partner's selection. Use as-is.
- **Target database**: not chosen yet. Propose a name and confirm in chat.

## Source

Use the `{source}-source` MCP to:

1. List tables in `{database}` with row counts and byte sizes.
2. For each table, fetch columns + types + nullable + defaults +
   constraints. Note Postgres-specific features that need mapping
   (JSONB, ARRAY, ENUM, SERIAL / IDENTITY, TIMESTAMPTZ, partitioned
   tables, materialised views).
3. List indexes (B-tree / GIN / partial / unique) — they're hints
   about which columns the workload actually filters on.
4. Identify fact vs dimension tables from foreign-key relationships
   and the analytical workload below.

## Analytical workload

```sql
{olap_queries}
```

Use the queries' filter / join / aggregation patterns to drive `ORDER BY`
choices on the target.

## Target

Use the `clickhousectl` MCP to:

1. Create the target database (suggested default `migration_demo`;
   confirm with the partner first).
2. Issue `CREATE TABLE` statements for every source table. Follow the
   ClickHouse Cloud best-practice rules attached to **clickhousectl**
   for engine, `ORDER BY`, `PARTITION BY`, and codec choices — justify
   each in chat.
3. Map source-specific types:
   - Postgres JSONB → `JSON` (or `String` if you need parse-on-read
     flexibility)
   - Postgres ARRAY → `Array(T)`
   - Postgres ENUM → `LowCardinality(String)` (or `Enum8` for a small,
     stable set)
   - Postgres TIMESTAMPTZ → `DateTime64(_, 'UTC')`
   - Postgres SERIAL / IDENTITY → smallest `UInt*` / `Int*` that fits
     the actual id range
4. **Handle nullable source columns deliberately.** A Postgres column
   reported as nullable in `information_schema.columns` (`is_nullable =
   'YES'`) can carry NULLs in practice; check `count(*) FILTER (WHERE
   <col> IS NULL)` if you're unsure. For each such column either:
   - Declare the target column as `Nullable(<T>)`, **or**
   - Declare non-Nullable with an explicit `DEFAULT` (e.g. `String
     DEFAULT ''`, `Int64 DEFAULT 0`) AND add a `transform=` lambda in
     step 2 that maps `None` → the same default before insert.
   Never leave a non-Nullable target column without either of those —
   the migration will fail mid-batch when the first NULL arrives.
5. Verify with `SHOW TABLES`.

## When you're done

Summarise source DB, target DB, and key schema choices in chat.
Subsequent steps refer back to these. Do **not** insert any data —
that's step 2.
