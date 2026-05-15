# Prompt 05 — Query Rewriting

The partner's analytical workload — the queries this migration needs
to make fast on ClickHouse:

```sql
{olap_queries}
```

Rewrite each query for ClickHouse. For each one, explain what changed
and why — I want to understand the differences, not just see the new
SQL. Common areas of attention:

- Function-name swaps (`NOW()` → `now()`, `DATE_TRUNC('month', x)` →
  `toStartOfMonth(x)`, `COALESCE` → `coalesce`, etc.).
- JSONB field access (`x->>'field'`) →
  `JSONExtractString(x, 'field')` (or `x.field` if the column is
  typed `JSON`).
- ARRAY operations and `unnest(...)` → `arrayJoin(...)`.
- Window functions and CTEs — most translate verbatim, but check
  partitioning syntax for differences.
- `GROUP BY ROLLUP / CUBE` → `WITH ROLLUP` / `WITH CUBE`.

After rewriting, run each query via **clickhousectl** and verify it
returns results. Then compare execution time with the Postgres
version and explain what accounts for the difference.
