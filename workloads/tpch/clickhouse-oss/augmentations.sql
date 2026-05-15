-- ──────────────────────────────────────────────────────────────────────
-- ClickHouse OSS dialect — TPC-H augmentations
-- ──────────────────────────────────────────────────────────────────────
-- Implements the four-augmentation contract from ../augmentations.md:
--   1. orders.order_metadata Map(String, String)
--   2. lineitem.delivery_at DateTime64(3, 'America/New_York') + ORDER BY
--   3. mv_daily_stats Materialized View on AggregatingMergeTree
--   4. customer.contact_addresses Array(Tuple(...))
--
-- Run via workloads/tpch/clickhouse-oss/load.py.
--
-- ClickHouse design note: re-creating a MergeTree table to change its
-- ORDER BY requires the swap pattern (build a parallel table, INSERT
-- SELECT, RENAME). Same idea as the BigQuery loader's
-- lineitem_repartitioned dance.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1. orders.order_metadata Map(String, String) ──────────────────────
-- ClickHouse can't add a Map column with a default in ALTER, so we
-- swap-rebuild. Map(String, String) is the most common idiomatic CH
-- shape for semi-structured key/value data; JSON would also be valid.
CREATE TABLE orders_augmented (
    o_orderkey      UInt32,
    o_custkey       UInt32,
    o_orderstatus   String,
    o_totalprice    Decimal(12, 2),
    o_orderdate     Date,
    o_orderpriority String,
    o_clerk         String,
    o_shippriority  UInt32,
    o_comment       String,
    order_metadata  Map(String, String)
) ENGINE = MergeTree ORDER BY o_orderkey;

INSERT INTO orders_augmented
SELECT
    o_orderkey,
    o_custkey,
    o_orderstatus,
    o_totalprice,
    o_orderdate,
    o_orderpriority,
    o_clerk,
    o_shippriority,
    o_comment,
    map(
        'payment_method', multiIf(o_orderkey % 4 = 0, 'credit_card',
                                  o_orderkey % 4 = 1, 'bank_transfer',
                                  o_orderkey % 4 = 2, 'paypal',
                                  'invoice'),
        'customer_segment', multiIf(o_orderkey % 3 = 0, 'premium',
                                    o_orderkey % 3 = 1, 'standard',
                                    'economy'),
        'order_source', multiIf(o_orderkey % 2 = 0, 'web', 'mobile'),
        'shipping_expedited', toString(o_orderkey % 5 = 0)
    )
FROM orders;

DROP TABLE orders;
RENAME TABLE orders_augmented TO orders;

-- ── 2. lineitem.delivery_at + ORDER BY (l_shipdate, l_orderkey) ───────
-- Swap-rebuild required to change ORDER BY. Source semantic: a
-- timezone-aware timestamp at l_shipdate midnight, America/New_York.
-- ClickHouse DateTime64(3, 'TZ') stores UTC under the hood with the
-- TZ as a display attribute, so the conversion happens at write time.
CREATE TABLE lineitem_augmented (
    l_orderkey      UInt32,
    l_partkey       UInt32,
    l_suppkey       UInt32,
    l_linenumber    UInt32,
    l_quantity      Decimal(12, 2),
    l_extendedprice Decimal(12, 2),
    l_discount      Decimal(12, 2),
    l_tax           Decimal(12, 2),
    l_returnflag    String,
    l_linestatus    String,
    l_shipdate      Date,
    l_commitdate    Date,
    l_receiptdate   Date,
    l_shipinstruct  String,
    l_shipmode      String,
    l_comment       String,
    delivery_at     DateTime64(3, 'America/New_York')
) ENGINE = MergeTree
PARTITION BY toYYYYMM(l_shipdate)
ORDER BY (l_shipdate, l_orderkey);

INSERT INTO lineitem_augmented
SELECT
    l_orderkey,
    l_partkey,
    l_suppkey,
    l_linenumber,
    l_quantity,
    l_extendedprice,
    l_discount,
    l_tax,
    l_returnflag,
    l_linestatus,
    l_shipdate,
    l_commitdate,
    l_receiptdate,
    l_shipinstruct,
    l_shipmode,
    l_comment,
    toDateTime64(concat(toString(l_shipdate), ' 00:00:00.000'), 3, 'America/New_York')
FROM lineitem;

DROP TABLE lineitem;
RENAME TABLE lineitem_augmented TO lineitem;

-- ── 3. mv_daily_stats — Materialized View on AggregatingMergeTree ─────
-- The canonical ClickHouse pattern for pre-aggregated rollups. The
-- target table holds aggregate STATES (countState / sumState) that
-- callers merge at read time. The MV captures future inserts; the
-- backfill INSERT below fills in the existing data.
CREATE TABLE daily_order_summary (
    order_day       Date,
    o_orderpriority String,
    order_count     AggregateFunction(count, UInt32),
    daily_revenue   AggregateFunction(sum, Decimal(12, 2))
) ENGINE = AggregatingMergeTree
ORDER BY (order_day, o_orderpriority);

CREATE MATERIALIZED VIEW mv_daily_stats TO daily_order_summary AS
SELECT
    o_orderdate                AS order_day,
    o_orderpriority,
    countState()               AS order_count,
    sumState(o_totalprice)     AS daily_revenue
FROM orders
GROUP BY order_day, o_orderpriority;

INSERT INTO daily_order_summary
SELECT
    o_orderdate                AS order_day,
    o_orderpriority,
    countState()               AS order_count,
    sumState(o_totalprice)     AS daily_revenue
FROM orders
GROUP BY order_day, o_orderpriority;

-- ── 4. customer.contact_addresses Array(Tuple(...)) ───────────────────
-- The typed-array shape that forces ClickHouse Array(Tuple(...))
-- handling on the migration target (vs. flattening to columns). 1–3
-- addresses per customer, deterministic from c_custkey.
CREATE TABLE customer_augmented (
    c_custkey         UInt32,
    c_name            String,
    c_address         String,
    c_nationkey       UInt32,
    c_phone           String,
    c_acctbal         Decimal(12, 2),
    c_mktsegment      String,
    c_comment         String,
    contact_addresses Array(Tuple(line String, city String, country String))
) ENGINE = MergeTree ORDER BY c_custkey;

INSERT INTO customer_augmented
SELECT
    c_custkey,
    c_name,
    c_address,
    c_nationkey,
    c_phone,
    c_acctbal,
    c_mktsegment,
    c_comment,
    arrayMap(
        addr_offset -> (
            concat(toString(c_custkey + addr_offset), ' Demo Street'),
            multiIf((c_custkey + addr_offset) % 5 = 0, 'New York',
                    (c_custkey + addr_offset) % 5 = 1, 'London',
                    (c_custkey + addr_offset) % 5 = 2, 'Tokyo',
                    (c_custkey + addr_offset) % 5 = 3, 'Berlin',
                    'Sydney'),
            multiIf((c_custkey + addr_offset) % 5 = 0, 'US',
                    (c_custkey + addr_offset) % 5 = 1, 'GB',
                    (c_custkey + addr_offset) % 5 = 2, 'JP',
                    (c_custkey + addr_offset) % 5 = 3, 'DE',
                    'AU')
        ),
        range(toUInt32(c_custkey % 3 + 1))
    )
FROM customer;

DROP TABLE customer;
RENAME TABLE customer_augmented TO customer;
