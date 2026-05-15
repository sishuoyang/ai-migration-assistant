# Step 4 — Rewrite the analytical queries for ClickHouse

Translate the partner's analytical queries from BigQuery dialect to
ClickHouse SQL. **This step is pure reasoning — no tool calls.** Keep
your rewrites in the chat thread; step 5 (Benchmark) will reference
them when it times each query.

## Queries to rewrite

The partner's current query set (the dashboard's Analytical Queries
dialog is the source of truth — this is what the partner has saved):

```sql
{olap_queries}
```

## Translation guide — BigQuery → ClickHouse

Helpful mappings for the common cases — consult the **clickhouse-docs**
MCP for anything else:

| BigQuery | ClickHouse |
|---|---|
| `CURRENT_TIMESTAMP()` | `now()` |
| `DATE_TRUNC(col, MONTH)` | `toStartOfMonth(col)` |
| `DATE_ADD(col, INTERVAL n DAY)` | `addDays(col, n)` |
| `EXTRACT(YEAR FROM col)` | `toYear(col)` |
| `ARRAY_AGG(x)` | `groupArray(x)` |
| `STRING_AGG(x, sep)` | `arrayStringConcat(groupArray(x), sep)` |
| STRUCT field access `t.col.field` | `t.col.field` (still works on `Tuple(...)`) or `JSONExtractString(col, 'field')` if column is typed `JSON` |
| ARRAY field access `t.col[OFFSET(0)].field` | `t.col[1].field` (ClickHouse arrays are 1-indexed) |
| `UNNEST(arr)` | `arrayJoin(arr)` |
| `SAFE_CAST(x AS type)` | `accurateCastOrNull(x, 'type')` or `toX(x)` with explicit null-handling |
| `IFNULL` / `COALESCE` | `ifNull` / `coalesce` |
| `IF(c, a, b)` | `if(c, a, b)` |
| Materialised view reads | Query the materialised target table directly |

## How to present each rewrite

For each query:

1. Show the **original** BigQuery SQL (verbatim from above).
2. Show the **rewritten** ClickHouse SQL.
3. Call out anything non-trivial — a function swap, a schema choice
   from step 1 (e.g. *"this column is typed `JSON` on the target, so
   I'm using `x.field` not `JSONExtractString`"*), an UNNEST that
   became `arrayJoin`, an OFFSET-0 access that became `[1]`.

Don't run anything here — step 5's `Benchmarker` runs every rewritten
query against the target as part of the timing comparison and
surfaces parse/runtime errors in the dashboard's **Benchmark** tab.
That's where verification lives, so a rewrite that doesn't parse will
surface there with the error message attached, and you can iterate.

## When you're done

Tell the partner:

1. You've translated N queries to ClickHouse SQL.
2. *"Click step 5 (Benchmark) to time them against BigQuery and verify
   they parse on the target."*

Step 5 will read your rewrites from the chat scrollback when it builds
its `Benchmarker.benchmark(queries=[...])` call.
