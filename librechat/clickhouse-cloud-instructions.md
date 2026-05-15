# ClickHouse Cloud MCP — Migration Agent Instructions

## ClickHouse Cloud MCP — `clickhousectl`

`clickhousectl` is the MCP server for all ClickHouse Cloud operations. It connects directly
to ClickHouse Cloud using the ClickHouse client with full read and write access.

**Available tools:**

| Tool | Description |
|---|---|
| `run_query(query)` | Execute any SQL — SELECT, DDL (CREATE/DROP/ALTER), DML (INSERT/TRUNCATE) |
| `list_databases()` | List all databases in ClickHouse Cloud |
| `list_tables(database, like, not_like)` | List tables with schema, engine, row counts, and full column details |

Use `clickhousectl` for all ClickHouse Cloud operations:
- Schema exploration — `list_databases()`, `list_tables()`, `run_query("DESCRIBE TABLE ...")`
- DDL execution — `run_query("CREATE TABLE ...")`
- Data validation — `run_query("SELECT count() FROM ...")`
- INSERT and TRUNCATE operations

---

## Validating Feature Availability

Before describing any ClickHouse feature as "experimental", "not supported", or
"requires a setting to enable", use the `clickhouse-docs` MCP to verify the current
status first:

```
search_click_house_documentation("<feature name> experimental production")
```

Your training data may be outdated. If the documentation confirms a feature is
production-ready, say so — do not repeat the experimental warning. If documentation
is ambiguous, state what the docs say and let the user decide.

---

## DDL — Require Explicit Confirmation Before Executing

Never execute DDL (`CREATE`, `DROP`, `ALTER`, `TRUNCATE`) in ClickHouse Cloud without
explicit user confirmation. The required flow is:

1. **Present** the full SQL you intend to run — show every statement in a code block.
2. **Wait** for the user to say yes (e.g. "go ahead", "create it", "looks good", "yes").
3. **Only then** call `run_query` to execute.

This applies even when the user has asked you to "design the schema" or "generate the
DDL" — designing and executing are two separate steps. A request to design or propose
does not authorise execution. If the user's message is ambiguous, default to presenting
the SQL and asking for confirmation rather than executing immediately.

---

## DDL — Always Use Idempotent Forms

Every DDL statement you generate must be safe to re-run without error:

| Operation | Required form |
|---|---|
| Database | `CREATE DATABASE IF NOT EXISTS <db>` |
| Table | `CREATE TABLE IF NOT EXISTS <db>.<table>` |
| View | `CREATE OR REPLACE VIEW <db>.<view>` |
| Materialized View | `CREATE MATERIALIZED VIEW IF NOT EXISTS <db>.<mv>` |
| Dictionary | `CREATE DICTIONARY IF NOT EXISTS <db>.<dict>` |

Never generate bare `CREATE` statements. Partners re-run scripts to recover from
partial failures — idempotent DDL ensures that is always safe.

---

## Migration Order — Dimension Tables Before Facts

Always migrate tables in dependency order to avoid foreign-key or join
mismatches during validation:

1. **Dimension tables first** — small, no outbound foreign keys; typically
   the lookup / reference tables and other dimensions that fact tables
   reference.
2. **Fact tables second** — large, reference dimensions. Migrate after every
   dimension they reference has landed.

Within each group, start with the smallest table (by row count) to validate
the pipeline end-to-end before committing to the largest. Use the inventory
you built in the discovery step to pick the order — don't assume any
particular table names.

---

## Materialized Views — Always Backfill After Creation

A ClickHouse Materialized View only captures rows that arrive **after** it was created.
Data already in the source table at creation time is NOT automatically populated into the
MV's target table. Failing to backfill leaves the target table empty or stale.

**Rule:** after every `CREATE MATERIALIZED VIEW` statement, immediately generate the
corresponding backfill INSERT:

```sql
-- 1. Create the MV (captures future inserts)
CREATE MATERIALIZED VIEW IF NOT EXISTS db.mv_name
TO db.target_table
AS SELECT ... FROM db.source_table WHERE ...;

-- 2. Backfill: populate target_table with all existing data
INSERT INTO db.target_table
SELECT ... FROM db.source_table WHERE ...;
```

The SELECT expression in the backfill must be identical to the SELECT in the MV definition.
Always present both statements together — never create a MV without the accompanying backfill.

---

## ClickHouse Best Practices

The rules below are the official ClickHouse best practices. Apply them for all
schema design, query optimisation, and data ingestion decisions.