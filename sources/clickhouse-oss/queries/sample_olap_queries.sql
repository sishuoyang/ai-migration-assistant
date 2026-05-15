-- Sample OLAP queries for the ClickHouse OSS TPC-H demo (database = `tpch`).
-- Mix of classic TPC-H analytical patterns plus queries that hit the
-- ClickHouse-specific augmentations (Map, DateTime64(TZ),
-- AggregatingMergeTree MV, Array(Tuple(...))).
-- Run `make tpch-load-clickhouse-oss` first; then point your `.env`
-- `CH_OSS_DB=tpch` to make the migration agent operate on this set.
--
-- The bundled web-analytics demo queries (sessions / pageviews /
-- conversions) still live alongside in `sample_queries_analytics.sql` —
-- paste those instead if your partner is running the bundled
-- `analytics` database.
--
-- Paste these into the migration agent during step 1 to extract
-- ORDER BY key and partition recommendations.

-- 1. Daily revenue rollup — hits the AggregatingMergeTree MV directly.
--    Reads countState / sumState aggregates via countMerge / sumMerge.
--    On the Cloud target this becomes the same pattern — the migration
--    has to recreate the MV + backfill rather than copy the binary
--    aggregate states (those are not portable across instances).
SELECT
    order_day,
    o_orderpriority,
    countMerge(order_count)                AS order_count,
    sumMerge(daily_revenue)                AS daily_revenue
FROM daily_order_summary
WHERE order_day BETWEEN '1995-01-01' AND '1995-12-31'
GROUP BY order_day, o_orderpriority
ORDER BY order_day, o_orderpriority;

-- 2. Top customers by lifetime revenue — multi-table join.
--    Exercises the agent's ability to reason about ORDER BY when the
--    primary GROUP BY column (c_name / c_custkey) lives in a dimension.
SELECT
    c.c_custkey,
    c.c_name,
    n.n_name                              AS nation,
    count(o.o_orderkey)                   AS order_count,
    sum(o.o_totalprice)                   AS lifetime_revenue
FROM orders   o
JOIN customer c  ON o.o_custkey = c.c_custkey
JOIN nation   n  ON c.c_nationkey = n.n_nationkey
WHERE o.o_orderstatus = 'F'
GROUP BY c.c_custkey, c.c_name, n.n_name
ORDER BY lifetime_revenue DESC
LIMIT 20;

-- 3. Payment method breakdown — extracts a key from the Map column.
--    Map access syntax is `m['key']` and returns '' for missing keys.
--    Forces the agent to choose between (a) extracting hot keys into
--    typed columns on the Cloud side, or (b) keeping the Map and
--    accessing keys at query time.
SELECT
    order_metadata['payment_method']      AS payment_method,
    order_metadata['customer_segment']    AS customer_segment,
    count()                               AS order_count,
    sum(o_totalprice)                     AS revenue
FROM orders
WHERE o_orderdate >= '1995-01-01'
  AND o_orderdate <  '1996-01-01'
GROUP BY payment_method, customer_segment
ORDER BY revenue DESC;

-- 4. Delivery latency by ship mode — uses the augmented DateTime64(3, 'America/New_York').
--    `delivery_at` is stored as UTC under the hood; the TZ is a display
--    attribute. Subtracting a Date gives a difference in seconds.
SELECT
    l_shipmode,
    count()                                                                                AS shipment_count,
    avg(toUnixTimestamp64Milli(delivery_at) / 1000.0 - toUnixTimestamp(toDateTime(l_shipdate, 'UTC'))) / 3600.0
        AS avg_delivery_hours
FROM lineitem
WHERE l_shipdate >= '1995-01-01'
  AND l_shipdate <  '1995-04-01'
GROUP BY l_shipmode
ORDER BY shipment_count DESC;

-- 5. Discounted revenue by part — classic TPC-H Q1 / Q3 pattern.
--    Heavy aggregation; benefits from a Materialized View on the
--    Cloud side too (parallel to daily_order_summary).
SELECT
    p.p_brand,
    p.p_type,
    sum(l.l_extendedprice * (1 - l.l_discount))  AS net_revenue,
    sum(l.l_quantity)                            AS qty_sold
FROM lineitem l
JOIN part     p  ON l.l_partkey = p.p_partkey
WHERE l.l_shipdate BETWEEN '1995-01-01' AND '1995-12-31'
GROUP BY p.p_brand, p.p_type
ORDER BY net_revenue DESC
LIMIT 50;

-- 6. Address-distribution lookup — exercises the Array(Tuple(...)).
--    `arrayJoin` unnests one row per element; named tuple access via
--    `addr.country` reaches the named field. The migration target
--    keeps this as Array(Tuple(...)) (typed) rather than Array(JSON).
SELECT
    addr.country                  AS country,
    uniq(c_custkey)               AS customers,
    count()                       AS total_addresses
FROM customer
ARRAY JOIN contact_addresses AS addr
GROUP BY country
ORDER BY customers DESC;
