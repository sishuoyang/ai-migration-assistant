## PostgreSQL Source — Migration Instructions

These rules apply when the data source is PostgreSQL.

---

## Schema Discovery — Don't Assume Anything

Never assume column names, table names, types, or that any particular
Postgres feature is or is not in use. Discover the actual schema at
runtime via the `postgres-source` MCP.

**Use `postgres-source` (not `migration-runner`) for ALL schema
discovery and read-only inspection of Postgres.** The `migration-runner`
MCP is **only** for data movement once the schema is understood —
running it for discovery is a footgun. Reasons:

- `postgres-source` exposes `execute_sql` which returns rows directly
  in the chat — no Python script to author, no `tail_python_job` round-
  trips, no opaque psycopg2 output to re-parse. One MCP call per query,
  one tool-call block per query, results visible to the partner inline.
- Using `migration-runner` for inspection means writing a 20-line
  Python script (connection setup, cursor, fetch, print) for what is
  one SQL query. The partner sees a `run_python` call with no output
  until the script exits; iterating ("oh, I also need to see indexes")
  means re-editing and re-running. Five run_python calls for what
  should be five `execute_sql` calls.
- `migration-runner` inherits env vars from the playground's `.env` via
  `env_file:`. If a stale `PG_DATABASE` is set there from a previous
  workload, a psycopg2 connection through `migration-runner` will scope
  to that database and your inventory will miss everything else.

**The discovery checklist for every Postgres migration** — every step
below is **one `execute_sql` call on `postgres-source`**:

1. **List databases and schemas:**
   ```sql
   SELECT datname FROM pg_database WHERE datistemplate = false;
   SELECT schema_name FROM information_schema.schemata
     WHERE schema_name NOT IN ('pg_catalog','information_schema');
   ```

2. **List every table with row counts and byte sizes** — one query,
   not per-table loops:
   ```sql
   SELECT n.nspname AS schema,
          c.relname AS table,
          c.reltuples::bigint AS approx_rows,
          pg_total_relation_size(c.oid) AS bytes
   FROM pg_class c
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r','p')                       -- table + partitioned table
     AND n.nspname NOT IN ('pg_catalog','information_schema')
   ORDER BY bytes DESC;
   ```

3. **Get columns + types + nullability + defaults** for a table:
   ```sql
   SELECT column_name, data_type, udt_name, is_nullable,
          column_default, character_maximum_length, numeric_precision, numeric_scale
   FROM information_schema.columns
   WHERE table_schema = '<schema>' AND table_name = '<table>'
   ORDER BY ordinal_position;
   ```

4. **List indexes** — hint at which columns the workload actually
   filters on:
   ```sql
   SELECT indexname, indexdef
   FROM pg_indexes
   WHERE schemaname = '<schema>' AND tablename = '<table>';
   ```

5. **Spot Postgres-specific features that need careful mapping**:
   ```sql
   -- ENUM types and their members (verify actual data with DISTINCT later)
   SELECT t.typname, e.enumlabel
   FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
   ORDER BY t.typname, e.enumsortorder;

   -- Materialised views
   SELECT schemaname, matviewname FROM pg_matviews;

   -- Partitioned-table parents
   SELECT n.nspname, c.relname FROM pg_class c
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = 'p';
   ```

6. **Sample data + nullability + cardinality** per column before
   designing the target — this is what tells you whether a column is
   `Nullable(T)`, a `LowCardinality(String)` candidate, or needs full
   Decimal precision:
   ```sql
   SELECT * FROM <schema>.<table> LIMIT 5;
   SELECT count(*), count(<col>) FROM <schema>.<table>;
   SELECT count(DISTINCT <col>) FROM <schema>.<table>;
   ```

Produce a migration inventory before generating any target schema. Do
not reach for `run_python` on `migration-runner` until step 2 (data
movement) — discovery is exclusively `postgres-source.execute_sql`.

---

## JSON Columns — COALESCE at String Level Before Casting

**JSONB/JSON columns from `postgresql()` arrive as `String`**, not as `JSON` type.
Never put a `CAST(..., 'JSON')` expression inside `COALESCE` alongside a String —
they have no common supertype. Always COALESCE at the String level first, then cast:

```sql
-- WRONG: String vs JSON inside COALESCE → NO_COMMON_TYPE error
COALESCE(json_col, CAST('{}', 'JSON'))

-- CORRECT: COALESCE both as String, cast the result
CAST(COALESCE(json_col, '{}'), 'JSON')
```

---

## Enum Columns — Always Verify Distinct Values Before Defining Enum8

Never define a ClickHouse `Enum8`/`Enum16` based on the Postgres schema definition alone.
Postgres ENUM type definitions can be outdated; the actual data often contains values
not listed in the type (added via `ALTER TYPE ... ADD VALUE`).

**Rule:** before writing any `Enum8(...)` in a CREATE TABLE, query the source:
```sql
-- Run this via postgres-source MCP before designing the column
SELECT DISTINCT <enum_col> FROM <table> ORDER BY 1;
```

If the column has unknown/unexpected values at migration time, the INSERT will fail with
`Unknown element '...' for enum`. Prefer `LowCardinality(String)` for status-like columns
in migration schemas — same compression and query performance, no enum drift risk:

```sql
-- Fragile: breaks if data contains any unlisted value
status Enum8('active' = 1, 'inactive' = 2)

-- Robust: handles any string value, same performance
status LowCardinality(String)
```

Use `Enum8` only when the value set is truly closed and controlled (e.g., a column
you own end-to-end). For migrated columns from external systems, default to
`LowCardinality(String)`.

---

## Type Coercion — COALESCE and Default Values

ClickHouse enforces strict type matching inside `COALESCE`. All arguments must share
a common supertype. Mixing `Decimal` with `Float64` (or `Nullable(T)` with a wrong
literal) raises `NO_COMMON_TYPE` at query time.

Rules when writing `COALESCE(col, fallback)` in migration SELECT statements:

| Source column type | Correct fallback form |
|---|---|
| `Decimal(P, S)` | `toDecimal64(0, S)` or `CAST(0 AS Decimal(P, S))` |
| `Float32 / Float64` | `0.0` (Float64 literal — fine as-is) |
| `Int* / UInt*` | `0` |
| `String` | `''` |
| `Array(T)` | `[]` — but cast if T is not inferred: `CAST([], 'Array(T)')` |
| `JSON` | `CAST('{}', 'JSON')` — not a String literal |
| `DateTime / Date` | `toDateTime(0)` / `toDate(0)` |
| `Nullable(T)` | Use `assumeNotNull(col)` if NULL is truly impossible, otherwise keep Nullable |

Never use a bare numeric literal as the fallback for a `Decimal` column.
Always inspect the target schema column type before writing the COALESCE default.

---

## Python Migration Scripts — PostgreSQL Source

When generating or adapting Python scripts to migrate from PostgreSQL, follow these rules.

**PostgreSQL connection** — read from environment variables:
```python
PG_HOST     = os.getenv("PG_HOST", "localhost")
PG_PORT     = int(os.getenv("PG_PORT", "5432"))
PG_USER     = os.getenv("PG_USER", "")
PG_PASSWORD = os.getenv("PG_PASSWORD", "")
PG_DB       = os.getenv("PG_DB", "")
```

**ClickHouse Cloud connection** — read from environment variables:
```python
CH_HOST     = os.environ["CLICKHOUSE_CLOUD_HOST"]
CH_PORT     = int(os.getenv("CLICKHOUSE_CLOUD_PORT", "8443"))
CH_USER     = os.environ.get("CLICKHOUSE_CLOUD_USER", "default")
CH_PASSWORD = os.environ["CLICKHOUSE_CLOUD_PASSWORD"]
CH_DB       = os.environ["CLICKHOUSE_CLOUD_DATABASE"]
```

**SSL certificate verification** — always pass `verify=False` to avoid macOS cert chain errors:
```python
client = clickhouse_connect.get_client(
    host=CH_HOST, port=8443,
    username=CH_USER, password=CH_PASSWORD,
    database=CH_DB,
    secure=True,
    verify=False,   # required on macOS — connection is still TLS-encrypted
)
```

**Always alias every function expression in SELECT** — `DictCursor`/`RealDictCursor` keys
rows by the SQL output name. `COALESCE(col, default)` produces key `'coalesce'`, not `'col'`,
causing a `KeyError` in the sanitize loop. Every non-trivial expression needs an explicit
`AS` alias matching the target column name:
```python
# WRONG — DictCursor row has key 'coalesce', not 'col_name'
"SELECT COALESCE(col_name, '') FROM t"

# CORRECT — row has key 'col_name'
"SELECT COALESCE(col_name, '') AS col_name FROM t"
```
This applies to COALESCE, CAST, arithmetic, and any expression that is not a plain
bare column reference.

**JSONB columns** — psycopg2 returns JSONB as Python dicts. Serialize to string before
inserting into ClickHouse JSON-type columns:
```python
if isinstance(val, dict):
    val = json.dumps(val, default=str)
```

**Array columns** — Postgres array types (e.g. `text[]`) arrive as Python lists, but
elements inside the list can be `None`. clickhouse-connect raises
`TypeError: object of type 'NoneType' has no len()` on `None` elements.
Sanitize before inserting:
```python
elif isinstance(val, list):
    val = ['' if x is None else str(x) for x in val]
```

**Never duplicate column names** — ClickHouse raises `DUPLICATE_COLUMN` if the same name
appears more than once in `column_names`. If the target table has a column the source
does not, use a SELECT alias (e.g. `created_at AS updated_at`) — never repeat a
column name in the list.

---

## postgresql() Table Function — Always Disable SSL for ngrok Tunnels

The ClickHouse `postgresql()` function negotiates SSL by default. ngrok TCP tunnels
are raw TCP — they do not terminate TLS. This causes every connection attempt to fail
with `received invalid response to SSL negotiation`.

Always pass `sslmode=disable` as the 7th argument when the Postgres host is a ngrok address:

```sql
-- Signature:
-- postgresql(host:port, database, table, user, password, schema, connection_string)

-- Correct form for ngrok:
FROM postgresql(
    '<ngrok-host>:<port>',
    '<database>',
    '<table>',
    '<user>',
    '<password>',
    '',                  -- schema (empty = public)
    'sslmode=disable'    -- required for ngrok TCP tunnels
)
```

Apply this to every `postgresql()` call in the migration script — SELECT, INSERT INTO ... SELECT,
and any table function used for row count checks.
