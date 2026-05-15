# Step 4 — Rewrite the analytical queries for ClickHouse

Translate the partner's analytical queries from Snowflake dialect to
ClickHouse SQL. **This step is pure reasoning — no tool calls.** Keep
your rewrites in the chat thread; step 5 (Benchmark) will reference
them when it times each query.

## Queries to rewrite

The partner's current query set (the dashboard's Analytical Queries
dialog is the source of truth — this is what the partner has saved):

```sql
{olap_queries}
```

## Translation guide — Snowflake → ClickHouse

Helpful mappings for the common cases — consult the **clickhouse-docs**
MCP for anything else:

| Snowflake | ClickHouse |
|---|---|
| `CURRENT_TIMESTAMP()` | `now()` |
| `DATE_TRUNC('month', x)` | `toStartOfMonth(x)` |
| `DATEADD(day, n, x)` | `addDays(x, n)` |
| `LISTAGG(col, sep)` | `arrayStringConcat(groupArray(col), sep)` |
| VARIANT field access `x:field` | `JSONExtractString(x, 'field')` (or `x.field` if column is typed `JSON`) |
| VARIANT array `x[0]` | `JSONExtractArrayRaw(x)[1]` (ClickHouse arrays are 1-indexed) |
| `IFF(c, a, b)` | `if(c, a, b)` |
| `COALESCE` / `IFNULL` | `coalesce` / `ifNull` |
| Dynamic Table reads | Query the materialised target table directly |

## How to present each rewrite

For each query:

1. Show the **original** Snowflake SQL (verbatim from above).
2. Show the **rewritten** ClickHouse SQL.
3. Call out anything non-trivial — a function swap, a schema choice
   from step 1 (e.g. *"this column is typed `JSON` on the target, so
   I'm using `x.field` not `JSONExtractString`"*), a column rename, a
   JOIN ordering change.

Don't run anything here — step 5's `Benchmarker` runs every rewritten
query against the target as part of the timing comparison and
surfaces parse/runtime errors in the dashboard's **Benchmark** tab.
That's where verification lives, so a rewrite that doesn't parse will
surface there with the error message attached, and you can iterate.

## When you're done

Tell the partner:

1. You've translated N queries to ClickHouse SQL.
2. *"Click step 5 (Benchmark) to time them against Snowflake and verify
   they parse on the target."*

Step 5 will read your rewrites from the chat scrollback when it builds
its `Benchmarker.benchmark(queries=[...])` call.
