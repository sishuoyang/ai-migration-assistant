# Prompt 06 — Performance Optimisation

Look at the most expensive aggregation queries from the partner's
workload (the slowest 2–3 from prompt 05, typically the ones that
scan a fact table fully or do a heavy GROUP BY).

For each one:

1. Use `EXPLAIN` (or `EXPLAIN PIPELINE` / `EXPLAIN ESTIMATE`) to show
   how ClickHouse is currently executing it.
2. Propose the best optimisation strategy and explain your reasoning.
   Pick from the standard levers:
   - **PROJECTION** when a filter / sort column isn't in the table's
     main `ORDER BY`.
   - **Materialised view** on `AggregatingMergeTree` (with `*State`
     aggregates and a backfill INSERT) for rollups over a large fact.
   - **Computed column** for a non-sargable filter (a function
     wrapped around the column).
   - **Dictionary** lookup for a small dimension that's joined on
     every query.
3. Implement it via **clickhousectl** and show the before/after
   query plan plus measured execution time.

Also review the full query set for any that are doing full table
scans when they shouldn't be. If you find any, explain what the
`ORDER BY` key design would need to look like to fix them — but
don't rebuild the table unless the partner asks; surface the change
as a recommendation.
