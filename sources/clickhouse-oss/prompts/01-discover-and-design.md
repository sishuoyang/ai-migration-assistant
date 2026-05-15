# Step 1 — Discover the source and design the ClickHouse Cloud target schema

You are migrating from `{source}` (a self-hosted ClickHouse instance)
to ClickHouse Cloud.

- **Source database**: `{database}` — the partner's selection. Use as-is.
- **Target database**: not chosen yet. Propose a name and confirm in chat.

## Source

Use the `{source}-source` MCP to:

1. List the tables in `{database}` with row counts and byte sizes.
2. For each table fetch the schema (`SHOW CREATE TABLE`), columns +
   types, the engine, `ORDER BY`, `PARTITION BY`, and settings.
3. Identify OSS-specific patterns that need attention for Cloud:
   - **Engine variants** — `CollapsingMergeTree`, `VersionedCollapsingMergeTree`,
     `GraphiteMergeTree`, `Buffer`, `Memory`, etc. Decide whether to
     carry them over, fold into `ReplacingMergeTree`, or drop.
   - **Distributed / Replicated tables** — Cloud is multi-replica
     by default; the source's `Distributed(...)` wrappers and
     `Replicated*MergeTree` engines collapse to plain `MergeTree`.
   - **`ON CLUSTER` DDL** — drop; Cloud is one logical cluster.
   - **Materialised views** — note the `TO <target_table>` pattern;
     recreate the MV + backfill on Cloud (see the Cloud rules).
   - **Custom codecs / TTL / settings** — list them; most carry over,
     but flag anything depending on a specific server config.
4. List dependent objects (`system.dependencies_table` /
   `system.tables`): MVs that feed off each table, dictionaries that
   reference them.

## Analytical workload

```sql
{olap_queries}
```

Use the queries' filter / join / aggregation patterns to validate the
source's `ORDER BY` choices and decide whether to preserve them or
re-key on the target.

## Target

Use the `clickhousectl` MCP to:

1. Create the target database (suggested default `migration_demo`;
   confirm with the partner first).
2. Issue `CREATE TABLE` statements. Default behaviour: **carry the
   source schema over verbatim** unless one of the OSS-specific
   patterns above forces a change, or the ClickHouse Cloud
   best-practice rules attached to **clickhousectl** suggest a better
   choice. Always explain when you deviate — in particular, if you
   **drop a `Nullable(<T>)` wrapper** in favour of a sentinel default,
   pair it with a `transform=` lambda in step 2 that maps `None` →
   the same default; otherwise the first NULL row aborts the
   migration mid-batch.
3. Verify with `SHOW TABLES`.

## When you're done

Summarise source DB, target DB, and any schema changes (with
justification) in chat. Subsequent steps refer back to these. Do
**not** insert any data — that's step 2.
