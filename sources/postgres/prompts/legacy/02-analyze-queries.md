# Prompt 02 — Query Pattern Analysis

Here is the partner's analytical workload — the queries this migration
needs to make fast on ClickHouse:

```sql
{olap_queries}
```

Analyse these queries to understand how the data is actually accessed.
Based on that analysis, recommend the best `ORDER BY` key for each
target ClickHouse table — and explain why (which predicate, which JOIN
key, which sort it serves).

Also flag any queries that will need significant rethinking in
ClickHouse — different join order, materialised view, projection,
sargability fix — and why.
