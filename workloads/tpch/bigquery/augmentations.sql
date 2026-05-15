-- ──────────────────────────────────────────────────────────────────────
-- BigQuery dialect — TPC-H augmentations
-- ──────────────────────────────────────────────────────────────────────
-- Implements the four-augmentation contract from ../augmentations.md:
--   1. orders.order_metadata STRUCT<...>
--   2. lineitem.delivery_at TIMESTAMP + PARTITION BY + CLUSTER BY
--   3. daily_order_summary MATERIALIZED VIEW
--   4. customer.contact_addresses ARRAY<STRUCT<...>>
--
-- Run via workloads/tpch/bigquery/load.py — it does the
-- ${BIGQUERY_PROJECT} / ${BIGQUERY_DATASET} substitution at execute time.
-- ──────────────────────────────────────────────────────────────────────

-- ── 1. orders.order_metadata STRUCT<...>  (semi-structured) ───────────
-- Forces the agent to decide ClickHouse JSON vs. typed-column flattening.
-- BigQuery requires re-creating the table for ADD COLUMN with STRUCT, so
-- we do it as CREATE OR REPLACE … AS SELECT in one shot.
CREATE OR REPLACE TABLE `${BIGQUERY_PROJECT}.${BIGQUERY_DATASET}.orders` AS
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
    STRUCT(
        CASE MOD(o_orderkey, 4)
            WHEN 0 THEN 'credit_card'
            WHEN 1 THEN 'bank_transfer'
            WHEN 2 THEN 'paypal'
            ELSE 'invoice'
        END AS payment_method,
        CASE MOD(o_orderkey, 3)
            WHEN 0 THEN 'premium'
            WHEN 1 THEN 'standard'
            ELSE 'economy'
        END AS customer_segment,
        CASE MOD(o_orderkey, 2)
            WHEN 0 THEN 'web'
            ELSE 'mobile'
        END AS order_source,
        MOD(o_orderkey, 5) = 0 AS shipping_expedited
    ) AS order_metadata
FROM `${BIGQUERY_PROJECT}.${BIGQUERY_DATASET}.orders`;

-- ── 2. lineitem.delivery_at TIMESTAMP + PARTITION BY + CLUSTER BY ─────
-- BigQuery TIMESTAMP is timezone-naive at the type level but stores UTC
-- under the hood. The TIMESTAMP() function with a TZ argument converts
-- the local-time string to a UTC instant — equivalent to Snowflake's
-- CONVERT_TIMEZONE('America/New_York', 'UTC', ...).
-- PARTITION BY enables month-level pruning. CLUSTER BY is BigQuery's
-- analogue to Snowflake CLUSTER BY / ClickHouse ORDER BY.
--
-- BigQuery rejects partition-spec changes via CREATE OR REPLACE TABLE
-- when the target already has a different (or no) partition spec, so
-- this uses the swap pattern: build a partitioned copy under a temp
-- name, drop the original, then RENAME. Idempotent on re-run because
-- the swap leaves the canonical `lineitem` name populated either way.
CREATE OR REPLACE TABLE `${BIGQUERY_PROJECT}.${BIGQUERY_DATASET}.lineitem_repartitioned`
PARTITION BY DATE_TRUNC(l_shipdate, MONTH)
CLUSTER BY l_orderkey, l_shipdate AS
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
    TIMESTAMP(FORMAT_DATE('%Y-%m-%d 00:00:00', l_shipdate), 'America/New_York') AS delivery_at
FROM `${BIGQUERY_PROJECT}.${BIGQUERY_DATASET}.lineitem`;

DROP TABLE `${BIGQUERY_PROJECT}.${BIGQUERY_DATASET}.lineitem`;

ALTER TABLE `${BIGQUERY_PROJECT}.${BIGQUERY_DATASET}.lineitem_repartitioned`
  RENAME TO lineitem;

-- ── 3. Materialized View — daily revenue rollup ───────────────────────
-- BigQuery MVs auto-refresh on the source's commits. The agent's job at
-- migration time is to project this into a ClickHouse MV on
-- AggregatingMergeTree + an explicit backfill INSERT.
CREATE MATERIALIZED VIEW IF NOT EXISTS `${BIGQUERY_PROJECT}.${BIGQUERY_DATASET}.daily_order_summary`
AS
SELECT
    o_orderdate                    AS order_day,
    o_orderpriority,
    COUNT(*)                       AS order_count,
    SUM(o_totalprice)              AS daily_revenue
FROM `${BIGQUERY_PROJECT}.${BIGQUERY_DATASET}.orders`
GROUP BY order_day, o_orderpriority;

-- ── 4. customer.contact_addresses ARRAY<STRUCT<...>> ──────────────────
-- Forces the agent into ClickHouse Array(Tuple(...)) territory. Each
-- customer gets 1–3 addresses, generated deterministically from
-- c_custkey so the workload is reproducible.
CREATE OR REPLACE TABLE `${BIGQUERY_PROJECT}.${BIGQUERY_DATASET}.customer` AS
SELECT
    c_custkey,
    c_name,
    c_address,
    c_nationkey,
    c_phone,
    c_acctbal,
    c_mktsegment,
    c_comment,
    -- 1–3 addresses per customer, derived from c_custkey for determinism.
    ARRAY(
        SELECT AS STRUCT
            CONCAT(CAST(c_custkey + offset AS STRING), ' Demo Street') AS line,
            CASE MOD(c_custkey + offset, 5)
                WHEN 0 THEN 'New York'
                WHEN 1 THEN 'London'
                WHEN 2 THEN 'Tokyo'
                WHEN 3 THEN 'Berlin'
                ELSE 'Sydney'
            END AS city,
            CASE MOD(c_custkey + offset, 5)
                WHEN 0 THEN 'US'
                WHEN 1 THEN 'GB'
                WHEN 2 THEN 'JP'
                WHEN 3 THEN 'DE'
                ELSE 'AU'
            END AS country
        FROM UNNEST(GENERATE_ARRAY(0, MOD(c_custkey, 3))) AS offset
    ) AS contact_addresses
FROM `${BIGQUERY_PROJECT}.${BIGQUERY_DATASET}.customer`;
