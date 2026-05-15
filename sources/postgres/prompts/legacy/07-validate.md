# Prompt 07 — Data Validation

Perform a complete integrity check between the Postgres source and the
ClickHouse target.

For each migrated table:

1. **Row count**: Postgres `COUNT(*)` vs ClickHouse `count()`.
2. **Numeric sum** on one key numeric column (any monetary,
   quantity, or measure column — pick whichever is most central to
   the table's role).
3. **Date range**: `MIN` / `MAX` of the primary timestamp column
   (or any monotonic column that bounds the data).
4. **NULL check**: count of `NULL`s in columns that used
   non-nullable Postgres types — there should be zero on the target.

Present results as a validation table:

| Table | Source rows | Target rows | Match? | Sum check | Date range match |

A successful migration should show:

- Row counts match exactly.
- Numeric sums match within 0.01% (floating-point rounding is
  acceptable; anything larger indicates data corruption or type-cast
  mismatch).
- Date ranges match.
- Zero unexpected `NULL`s in columns that were non-nullable on the
  source.
