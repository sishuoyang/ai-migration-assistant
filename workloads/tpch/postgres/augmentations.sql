-- ──────────────────────────────────────────────────────────────────────
-- PostgreSQL dialect — TPC-H augmentations
-- ──────────────────────────────────────────────────────────────────────
-- Implements the four-augmentation contract from ../augmentations.md:
--   1. orders.order_metadata JSONB
--   2. lineitem.delivery_at TIMESTAMPTZ + BRIN index
--   3. daily_order_summary MATERIALIZED VIEW
--   4. customer.contact_addresses JSONB (array of objects)
--
-- Run via workloads/tpch/postgres/load.py.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1. orders.order_metadata JSONB  (semi-structured) ─────────────────
-- Forces the agent to decide ClickHouse JSON vs. typed-column flattening.
-- Postgres supports ADD COLUMN with a default expression, so a single
-- ALTER + UPDATE populates every row without rebuilding the table.
ALTER TABLE orders ADD COLUMN order_metadata JSONB;
UPDATE orders SET order_metadata = jsonb_build_object(
    'payment_method', CASE o_orderkey % 4
        WHEN 0 THEN 'credit_card'
        WHEN 1 THEN 'bank_transfer'
        WHEN 2 THEN 'paypal'
        ELSE 'invoice'
    END,
    'customer_segment', CASE o_orderkey % 3
        WHEN 0 THEN 'premium'
        WHEN 1 THEN 'standard'
        ELSE 'economy'
    END,
    'order_source', CASE o_orderkey % 2
        WHEN 0 THEN 'web'
        ELSE 'mobile'
    END,
    'shipping_expedited', (o_orderkey % 5 = 0)
);
ALTER TABLE orders ALTER COLUMN order_metadata SET NOT NULL;

-- ── 2. lineitem.delivery_at TIMESTAMPTZ + BRIN index ──────────────────
-- Stores the timestamp in UTC under the hood; the TZ semantics are
-- preserved via the AT TIME ZONE conversion. BRIN is Postgres's
-- block-range index — well-suited to large append-only tables ordered
-- by a date column (l_shipdate). The agent's job at migration time is
-- to translate this into a ClickHouse partition + ORDER BY pattern.
ALTER TABLE lineitem ADD COLUMN delivery_at TIMESTAMPTZ;
UPDATE lineitem SET delivery_at = (l_shipdate::timestamp AT TIME ZONE 'America/New_York');
ALTER TABLE lineitem ALTER COLUMN delivery_at SET NOT NULL;
CREATE INDEX IF NOT EXISTS lineitem_shipdate_brin
    ON lineitem USING BRIN (l_shipdate);

-- ── 3. Materialized View — daily revenue rollup ───────────────────────
-- Postgres materialized views are manual-refresh (REFRESH MATERIALIZED
-- VIEW). The agent translates this into a ClickHouse Materialized View
-- on AggregatingMergeTree + an explicit backfill INSERT.
CREATE MATERIALIZED VIEW daily_order_summary AS
SELECT
    o_orderdate                AS order_day,
    o_orderpriority,
    COUNT(*)                   AS order_count,
    SUM(o_totalprice)          AS daily_revenue
FROM orders
GROUP BY o_orderdate, o_orderpriority;
CREATE UNIQUE INDEX daily_order_summary_pk
    ON daily_order_summary (order_day, o_orderpriority);

-- ── 4. customer.contact_addresses JSONB array of objects ──────────────
-- Forces the agent into ClickHouse Array(Tuple(...)) or Array(JSON)
-- territory. 1–3 addresses per customer, deterministic from c_custkey.
ALTER TABLE customer ADD COLUMN contact_addresses JSONB;
UPDATE customer SET contact_addresses = (
    SELECT jsonb_agg(jsonb_build_object(
        'line',    (c_custkey + addr_offset) || ' Demo Street',
        'city',    CASE (c_custkey + addr_offset) % 5
                        WHEN 0 THEN 'New York'
                        WHEN 1 THEN 'London'
                        WHEN 2 THEN 'Tokyo'
                        WHEN 3 THEN 'Berlin'
                        ELSE 'Sydney'
                    END,
        'country', CASE (c_custkey + addr_offset) % 5
                        WHEN 0 THEN 'US'
                        WHEN 1 THEN 'GB'
                        WHEN 2 THEN 'JP'
                        WHEN 3 THEN 'DE'
                        ELSE 'AU'
                    END
    ))
    FROM generate_series(0, c_custkey % 3) AS addr_offset
);
ALTER TABLE customer ALTER COLUMN contact_addresses SET NOT NULL;
