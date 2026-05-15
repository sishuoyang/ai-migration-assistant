-- Reference ClickHouse Cloud target schema for the BigQuery migration_demo
-- workload. Used by step 3 validation to cross-check the schema the agent
-- proposes during step 1.
--
-- The agent's actual choices may differ — what matters is the reasoning,
-- not bit-for-bit identity with this reference.

CREATE DATABASE IF NOT EXISTS migration_target;

-- ── Dimension tables (small, no partitioning) ─────────────────────────
CREATE TABLE IF NOT EXISTS migration_target.region (
    r_regionkey  UInt8,
    r_name       LowCardinality(String),
    r_comment    String
) ENGINE = MergeTree ORDER BY r_regionkey;

CREATE TABLE IF NOT EXISTS migration_target.nation (
    n_nationkey  UInt8,
    n_name       LowCardinality(String),
    n_regionkey  UInt8,
    n_comment    String
) ENGINE = MergeTree ORDER BY n_nationkey;

CREATE TABLE IF NOT EXISTS migration_target.supplier (
    s_suppkey    UInt32,
    s_name       String,
    s_address    String,
    s_nationkey  UInt8,
    s_phone      LowCardinality(String),
    s_acctbal    Decimal(12, 2),
    s_comment    String
) ENGINE = MergeTree ORDER BY s_suppkey;

CREATE TABLE IF NOT EXISTS migration_target.part (
    p_partkey       UInt32,
    p_name          String,
    p_mfgr          LowCardinality(String),
    p_brand         LowCardinality(String),
    p_type          LowCardinality(String),
    p_size          UInt8,
    p_container     LowCardinality(String),
    p_retailprice   Decimal(12, 2),
    p_comment       String
) ENGINE = MergeTree ORDER BY p_partkey;

CREATE TABLE IF NOT EXISTS migration_target.partsupp (
    ps_partkey      UInt32,
    ps_suppkey      UInt32,
    ps_availqty     UInt32,
    ps_supplycost   Decimal(12, 2),
    ps_comment      String
) ENGINE = MergeTree ORDER BY (ps_partkey, ps_suppkey);

-- customer carries the BigQuery ARRAY<STRUCT<...>> augmentation:
-- contact_addresses maps cleanly to Array(Tuple(...)).
CREATE TABLE IF NOT EXISTS migration_target.customer (
    c_custkey          UInt32,
    c_name             String,
    c_address          String,
    c_nationkey        UInt8,
    c_phone            LowCardinality(String),
    c_acctbal          Decimal(12, 2),
    c_mktsegment       LowCardinality(String),
    c_comment          String,
    contact_addresses  Array(Tuple(line String, city LowCardinality(String), country LowCardinality(String)))
) ENGINE = MergeTree ORDER BY c_custkey;

-- ── Fact tables ───────────────────────────────────────────────────────
-- orders: partition by month for time-window pruning;
--         JSON column for the BigQuery STRUCT augmentation.
CREATE TABLE IF NOT EXISTS migration_target.orders (
    o_orderkey       UInt32,
    o_custkey        UInt32,
    o_orderstatus    LowCardinality(String),
    o_totalprice     Decimal(12, 2),
    o_orderdate      Date,
    o_orderpriority  LowCardinality(String),
    o_clerk          LowCardinality(String),
    o_shippriority   UInt8,
    o_comment        String,
    -- Mapped from BigQuery STRUCT<payment_method, customer_segment, order_source, shipping_expedited>:
    order_metadata   JSON
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(o_orderdate)
ORDER BY (o_orderdate, o_orderkey);

-- lineitem: partition by ship-month; ORDER BY (l_orderkey, l_shipdate)
-- mirrors the BigQuery CLUSTER BY. delivery_at is the TIMESTAMP
-- augmentation, mapped to UTC.
CREATE TABLE IF NOT EXISTS migration_target.lineitem (
    l_orderkey         UInt32,
    l_partkey          UInt32,
    l_suppkey          UInt32,
    l_linenumber       UInt8,
    l_quantity         Decimal(12, 2),
    l_extendedprice    Decimal(12, 2),
    l_discount         Decimal(12, 2),
    l_tax              Decimal(12, 2),
    l_returnflag       LowCardinality(String),
    l_linestatus       LowCardinality(String),
    l_shipdate         Date,
    l_commitdate       Date,
    l_receiptdate      Date,
    l_shipinstruct     LowCardinality(String),
    l_shipmode         LowCardinality(String),
    l_comment          String,
    -- Mapped from BigQuery TIMESTAMP (already UTC under the hood):
    delivery_at        DateTime64(3, 'UTC')
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(l_shipdate)
ORDER BY (l_orderkey, l_shipdate);

-- ── Materialized View — replaces the BigQuery MV ──────────────────────
-- AggregatingMergeTree backing store + MV trigger for inserts.
CREATE TABLE IF NOT EXISTS migration_target.daily_order_summary_agg (
    order_day         Date,
    o_orderpriority   LowCardinality(String),
    order_count_state AggregateFunction(count),
    revenue_state     AggregateFunction(sum, Decimal(12, 2))
) ENGINE = AggregatingMergeTree
ORDER BY (order_day, o_orderpriority);

CREATE MATERIALIZED VIEW IF NOT EXISTS migration_target.mv_daily_order_summary
TO migration_target.daily_order_summary_agg AS
SELECT
    toDate(o_orderdate)                AS order_day,
    o_orderpriority,
    countState()                       AS order_count_state,
    sumState(o_totalprice)             AS revenue_state
FROM migration_target.orders
GROUP BY order_day, o_orderpriority;

-- Backfill from existing data (run after the MV is created):
-- INSERT INTO migration_target.daily_order_summary_agg
-- SELECT toDate(o_orderdate), o_orderpriority,
--        countState(), sumState(o_totalprice)
-- FROM migration_target.orders GROUP BY 1, 2;

-- ── Notes on key decisions ────────────────────────────────────────────
-- 1. NUMERIC(P, S) → Decimal(P, S). Never Float for monetary columns.
-- 2. TIMESTAMP → DateTime64(3, 'UTC'). BigQuery TIMESTAMP is already UTC
--    under the hood; only the load-time TZ-conversion logic differs.
-- 3. STRUCT<...> → JSON. Hot keys (payment_method, customer_segment) can
--    be extracted to typed materialised columns if the query patterns
--    warrant it.
-- 4. ARRAY<STRUCT<line, city, country>> → Array(Tuple(...)). Typed,
--    fast lookups via UNNEST → arrayJoin.
-- 5. BigQuery PARTITION BY DATE_TRUNC(col, MONTH) → ClickHouse PARTITION
--    BY toYYYYMM(col). CLUSTER BY columns become the leading ORDER BY
--    columns.
-- 6. The BigQuery MATERIALIZED VIEW is replaced with a ClickHouse MV on
--    AggregatingMergeTree. Both auto-refresh on insert; the backfill
--    INSERT is required to populate historical data on the CH side.
