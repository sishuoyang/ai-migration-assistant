# Prompt 03 — ClickHouse Schema Design

You've now seen the full source schema and the analytical workload.
Design an optimised ClickHouse schema for a fresh target database
(propose a name and confirm with the partner in chat; suggested
default `migration_demo`).

For each source table, make and explain your choices:

- Which MergeTree engine variant, and why (`MergeTree` for facts,
  `ReplacingMergeTree` for tables that need de-duplication on a
  natural key, `SummingMergeTree` / `AggregatingMergeTree` if the
  partner's workload aggregates one table heavily, etc.).
- Which columns to put in `ORDER BY`, and in what order — show your
  reasoning against the query patterns from prompt 02.
- Whether to add `PARTITION BY`, and why or why not (only when a
  low-cardinality time column cleanly aligns with the workload).
- How to handle any Postgres-specific types or features
  (JSONB → `JSON` or `String`; ARRAY → `Array(T)`; ENUM →
  `LowCardinality(String)` or `Enum8`; TIMESTAMPTZ →
  `DateTime64(_, 'UTC')`; SERIAL / IDENTITY → smallest `UInt*` /
  `Int*` that fits the actual id range, etc.).
- Any columns where the default-value strategy matters.

I want to understand the thinking behind each decision, not just
the SQL.

Once the design is agreed, create the database and execute all the
`CREATE TABLE` statements via **clickhousectl**. Verify each table
was created successfully (`SHOW TABLES`).
