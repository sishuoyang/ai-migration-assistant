# Prompt 04 — Data Migration

Migrate data from each Postgres table into the ClickHouse Cloud target
database using the `postgresql()` table function. No intermediate
files — it's a direct `INSERT ... SELECT` from Postgres.

> **Before you start — network reachability:**
> ClickHouse Cloud executes the `postgresql()` function from its cloud
> environment, so it needs to reach the partner's Postgres instance
> over the internet. A local Docker hostname like `postgres:5432` is
> not reachable from Cloud.
>
> Pick one of these options and substitute the resulting host in every
> query below:
>
> **Option A — Tunnel (quickest):**
> ```bash
> ngrok tcp 5432   # gives you something like 0.tcp.ngrok.io:12345
> ```
> Use the ngrok address as the host:port.
>
> **Option B — Export to S3/GCS then import:**
> ```sql
> -- In Postgres: COPY <table> TO PROGRAM 'aws s3 cp - s3://bucket/<table>.csv'
> -- In ClickHouse: INSERT INTO <target_db>.<table>
> --                SELECT * FROM s3('s3://bucket/<table>.csv', ...)
> ```

## Migration order

Migrate dimension tables before facts so foreign-key columns on the
facts already resolve. Concretely:

1. Any table that other tables reference but doesn't reference others
   (pure dimensions) — migrate first.
2. Tables that join two dimensions (bridge / lookup tables) — next.
3. The fact tables — last, in decreasing dimension dependency order.

For very large fact tables (>10M rows), batch the migration by a
time column (or any monotonically partitioned column) so the
ClickHouse Cloud session doesn't time out:

```sql
INSERT INTO <target_db>.<fact_table>
SELECT <columns>
FROM postgresql(
    '<host:port>', '<source_db>', '<fact_table>',
    '<pg_user>', '<pg_password>'
)
WHERE <partition_col> >= '<lower>' AND <partition_col> < '<upper>';
-- repeat for each batch range.
```

## Procedure per table

For each table, in dependency order:

1. Show the `INSERT ... SELECT` statement before executing.
2. Execute via **clickhousectl**.
3. Verify: compare `count()` in ClickHouse against `COUNT(*)` in
   Postgres (use the partner's preferred check tool, or eyeball the
   numbers as you go — full validation happens in prompt 07).

## Pattern

```sql
INSERT INTO <target_db>.<table>
SELECT <columns in target order>
FROM postgresql(
    '<host:port>', '<source_db>', '<table>',
    '<pg_user>', '<pg_password>'
);
```

Replace the placeholders with the partner's actual credentials —
read them from the connection details the partner shared (or the
`.env` they configured). Never hard-code credentials in committed
SQL.
