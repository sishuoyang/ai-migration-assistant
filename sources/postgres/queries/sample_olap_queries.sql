-- Sample OLAP queries for the Postgres TPC-H demo (database = `tpch`).
-- Mix of classic TPC-H analytical patterns plus queries that hit the
-- Postgres-specific augmentations (JSONB, TIMESTAMPTZ, MV, JSONB-array).
-- Run `make tpch-load-postgres` first; then point your `.env`
-- `POSTGRES_DB=tpch` to make the migration agent operate on this set.
--
-- The bundled e-commerce demo queries (users / orders / events / etc.)
-- still live alongside in `sample_queries_ecommerce.sql` — paste those
-- instead if your partner is running the bundled `ecommerce` database.
--
-- Paste these into the migration agent during step 1 to extract
-- ORDER BY key and partition recommendations.

-- 1. Daily revenue rollup — hits the Postgres MATERIALIZED VIEW directly.
--    On the ClickHouse side this becomes a Materialized View on
--    AggregatingMergeTree (or a query against the underlying `orders`).
SELECT
    order_day,
    o_orderpriority,
    order_count,
    daily_revenue
FROM daily_order_summary
WHERE order_day BETWEEN '1995-01-01' AND '1995-12-31'
ORDER BY order_day, o_orderpriority;

-- 2. Top customers by lifetime revenue — multi-table join.
--    Exercises the agent's ability to reason about ORDER BY when the
--    primary GROUP BY column (c_name / c_custkey) lives in a dimension.
SELECT
    c.c_custkey,
    c.c_name,
    n.n_name                              AS nation,
    COUNT(o.o_orderkey)                   AS order_count,
    SUM(o.o_totalprice)                   AS lifetime_revenue
FROM orders   o
JOIN customer c  ON o.o_custkey = c.c_custkey
JOIN nation   n  ON c.c_nationkey = n.n_nationkey
WHERE o.o_orderstatus = 'F'
GROUP BY c.c_custkey, c.c_name, n.n_name
ORDER BY lifetime_revenue DESC
LIMIT 20;

-- 3. Payment method breakdown — extracts a key from the JSONB column.
--    Forces the agent to choose between (a) extracting hot keys into
--    typed columns on the ClickHouse side, or (b) keeping a JSON column
--    and using JSONExtractString() at query time.
SELECT
    order_metadata->>'payment_method'      AS payment_method,
    order_metadata->>'customer_segment'    AS customer_segment,
    COUNT(*)                                AS order_count,
    SUM(o_totalprice)                       AS revenue
FROM orders
WHERE o_orderdate >= '1995-01-01'
  AND o_orderdate <  '1996-01-01'
GROUP BY payment_method, customer_segment
ORDER BY revenue DESC;

-- 4. Delivery latency by ship mode — uses the augmented TIMESTAMPTZ column.
--    Forces the agent to think about timezone normalisation
--    (Postgres TIMESTAMPTZ → ClickHouse DateTime64(3, 'UTC')).
SELECT
    l_shipmode,
    COUNT(*)                                                          AS shipment_count,
    AVG(EXTRACT(EPOCH FROM (delivery_at - l_shipdate::timestamptz)) / 3600.0) AS avg_delivery_hours
FROM lineitem
WHERE l_shipdate >= '1995-01-01'
  AND l_shipdate <  '1995-04-01'
GROUP BY l_shipmode
ORDER BY shipment_count DESC;

-- 5. Discounted revenue by part — classic TPC-H Q1 / Q3 pattern.
--    Heavy aggregation; benefits from a Materialized View on the CH side.
SELECT
    p.p_brand,
    p.p_type,
    SUM(l.l_extendedprice * (1 - l.l_discount))  AS net_revenue,
    SUM(l.l_quantity)                            AS qty_sold
FROM lineitem l
JOIN part     p  ON l.l_partkey = p.p_partkey
WHERE l.l_shipdate BETWEEN '1995-01-01' AND '1995-12-31'
GROUP BY p.p_brand, p.p_type
ORDER BY net_revenue DESC
LIMIT 50;

-- 6. Address-distribution lookup — exercises the nested JSONB array.
--    Forces the agent into ClickHouse arrayJoin() + 1-indexed arrays,
--    and into deciding Array(Tuple(...)) vs. Array(JSON) on the target.
SELECT
    addr->>'country'                AS country,
    COUNT(DISTINCT c.c_custkey)     AS customers,
    COUNT(*)                        AS total_addresses
FROM customer c,
     jsonb_array_elements(c.contact_addresses) AS addr
GROUP BY country
ORDER BY customers DESC;
