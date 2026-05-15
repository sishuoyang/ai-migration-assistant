# Step 4 — Rewrite the analytical queries for ClickHouse

Translate the partner's analytical queries from Postgres dialect to
ClickHouse SQL. **This step is pure reasoning — no tool calls.** Keep
your rewrites in the chat thread; step 5 (Benchmark) will reference
them when it times each query.

## Queries to rewrite

```sql
{olap_queries}
```

## Translation guide — Postgres → ClickHouse

Helpful mappings for the common cases — consult the **clickhouse-docs**
MCP for anything else:

| Postgres | ClickHouse |
|---|---|
| `NOW()` / `CURRENT_TIMESTAMP` | `now()` |
| `DATE_TRUNC('month', x)` | `toStartOfMonth(x)` |
| `EXTRACT(YEAR FROM x)` | `toYear(x)` |
| `x::INT` / `CAST(x AS INT)` | `toInt32(x)` (or `accurateCastOrNull` for safe cast) |
| `x->>'field'` (JSONB text) | `JSONExtractString(x, 'field')` (or `x.field` if column is typed `JSON`) |
| `x->'field'` (JSONB sub) | `JSONExtractRaw(x, 'field')` |
| `unnest(arr)` | `arrayJoin(arr)` |
| `array_agg(x)` | `groupArray(x)` |
| `string_agg(x, sep)` | `arrayStringConcat(groupArray(x), sep)` |
| `COALESCE` / `NULLIF` | `coalesce` / `nullIf` |
| `GROUP BY ROLLUP(...)` | `GROUP BY ... WITH ROLLUP` |
| `GROUP BY CUBE(...)` | `GROUP BY ... WITH CUBE` |
| Window functions | mostly verbatim — verify partition/order syntax |

## How to present each rewrite

For each query:

1. Show the **original** Postgres SQL.
2. Show the **rewritten** ClickHouse SQL.
3. Call out anything non-trivial — a function swap, a schema choice
   from step 1 (e.g. *"this column is typed `JSON` on the target, so
   I'm using `x.field` not `JSONExtractString`"*), a JOIN re-order, a
   sargability fix.

Don't run anything here — step 5's `Benchmarker` runs every rewritten
query against the target as part of the timing comparison and surfaces
parse / runtime errors in the dashboard's **Benchmark** tab.

## When you're done

Tell the partner:

1. You've translated N queries to ClickHouse SQL.
2. *"Click step 5 (Benchmark) to time them against Postgres and verify
   they parse on the target."*

Step 5 will read your rewrites from the chat scrollback when it builds
its `Benchmarker.benchmark(queries=[...])` call.
