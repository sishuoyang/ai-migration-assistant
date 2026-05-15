# Object Storage Staging for Large Snowflake → ClickHouse Cloud Migrations

For tables larger than ~1 million rows, the playground's default
direct-INSERT path becomes the slow part of the migration: every row
round-trips Snowflake → Python (in `migration-runner`) → ClickHouse Cloud
over the network. **S3 staging** removes that hop. Snowflake bulk-exports
the table to Parquet in S3 (`COPY INTO @ext_stage`), ClickHouse Cloud
bulk-reads it (`INSERT FROM s3()`), and the wire path is cloud-to-cloud
the whole way — typically **5–10× faster** end-to-end on the largest tables.

You don't have to use it. If `STAGING_S3_*` is unset, the agent and
`migrationkit` quietly fall back to the direct path. This page exists so
the partner can light up the faster path when they want to.

> **Already ran the Snowflake Terraform module with `-var=create_staging_bucket=true`?**
> The `env_block` output already populated the five `STAGING_S3_*`
> values in your `.env`. Skip ahead to **§5 Restart the runner** — the
> bucket, IAM user, lifecycle rule, and access key are already created
> for you. The manual walkthrough below (§§ 1–4) is for partners who
> prefer to BYO an existing S3 bucket and IAM identity.

> **Source support**: Snowflake (`COPY INTO @stage`) and ClickHouse OSS
> (`INSERT INTO FUNCTION s3()`) both support the S3 staging path.
> Postgres has no native bulk-export-to-S3 and still uses the direct
> path even when S3 is configured. Bucket location: same AWS region as
> the ClickHouse Cloud service is strongly recommended (cross-region
> reads are slower and cost money on the ClickHouse Cloud side).

---

## 1. What you need

| Item | Why |
|---|---|
| An AWS account where you can create an S3 bucket and an IAM policy | Holds the staged Parquet files between Snowflake unload and ClickHouse load |
| Snowflake account with `ACCOUNTADMIN` (or a role that can create stages and storage integrations) | Lets Snowflake's `COPY INTO @stage` write to your bucket |
| ClickHouse Cloud service running and reachable from the playground | Loads the staged files via `INSERT FROM s3()` |

The playground itself runs entirely on your laptop; only the staging
bucket lives in the cloud.

---

## 2. Create the staging bucket

```bash
aws s3api create-bucket \
  --bucket my-migration-staging \
  --region us-east-1 \
  --create-bucket-configuration LocationConstraint=us-east-1
```

(Skip `LocationConstraint` if you're using `us-east-1` and your AWS CLI
complains.) Pick a region close to your Snowflake account and ClickHouse
Cloud service.

Optionally turn on lifecycle expiration so staged files don't accumulate
if `cleanup_staged=False` ever leaves them behind:

```bash
aws s3api put-bucket-lifecycle-configuration \
  --bucket my-migration-staging \
  --lifecycle-configuration '{
    "Rules": [{
      "ID": "expire-migrationkit-prefix",
      "Status": "Enabled",
      "Filter": {"Prefix": "migrationkit/"},
      "Expiration": {"Days": 7}
    }]
  }'
```

---

## 3. AWS IAM for Snowflake's `COPY INTO @stage`

The simplest setup (and what `migrationkit` uses today) is **inline
credentials on the Snowflake stage**: Snowflake authenticates to S3 with
an IAM user's access key + secret. No storage integration / role
assumption required.

Create an IAM user with programmatic credentials, attached to this policy
(replace the bucket name):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ListBucket",
      "Effect": "Allow",
      "Action": ["s3:ListBucket", "s3:GetBucketLocation"],
      "Resource": "arn:aws:s3:::my-migration-staging"
    },
    {
      "Sid": "RWPrefix",
      "Effect": "Allow",
      "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::my-migration-staging/migrationkit/*"
    }
  ]
}
```

The `migrationkit/` prefix matches the default `STAGING_S3_PREFIX`. If
you set a different prefix in `.env`, adjust the policy accordingly. The
same key/secret is given to ClickHouse's `s3()` table function on the
read side, so this one user covers both write and read.

> **Production note**: For a long-running production setup, prefer a
> Snowflake storage integration (assume-role from Snowflake's external
> ID) over inline credentials. This playground uses inline creds for
> brevity. A storage-integration variant of `unload_to_s3` would be a
> small follow-up if you need it.

---

## 4. Set `STAGING_S3_*` in `.env`

```dotenv
STAGING_S3_BUCKET=my-migration-staging
STAGING_S3_REGION=us-east-1
STAGING_S3_ACCESS_KEY_ID=AKIA...
STAGING_S3_SECRET_ACCESS_KEY=...
STAGING_S3_PREFIX=migrationkit
```

Then restart the runner so the env propagates:

```bash
docker compose up -d --force-recreate migration-runner
```

You don't need to rebuild — env values are read at process start.

---

## 5. Verify it's wired

From inside the playground:

```bash
docker compose exec migration-runner python -c "
from migrationkit import S3Stage
from migrationkit.staging.s3 import list_s3_objects
stage = S3Stage.from_env()
print('bucket  :', stage.bucket)
print('prefix  :', stage.prefix)
print('s3 uri  :', stage.s3_uri('verify', 'test'))
# Empty list_objects on a fresh prefix returns [] — confirms creds work.
print('objects :', list_s3_objects(stage, 'verify', 'test'))
"
```

If you see `bucket`, `prefix`, `s3 uri`, and `objects: []`, you're wired.
If you see `botocore.exceptions.NoCredentialsError` or `AccessDenied`,
the IAM policy isn't right yet — recheck the resource ARNs and the
inline-credential setup.

---

## 6. Drive a migration through the dashboard

Open `https://localhost/dashboard/`, pick the Snowflake source, and click
**② Migrate Data**. The agent inspects each table from step 1:

- Tables with `≤ 1M rows` get `m.add_table(...)` (direct path)
- Tables with `> 1M rows` get `m.add_table_via_s3(name=..., stage=S3Stage.from_env())`

While the migration runs, watch the dashboard's KPI hero:

- For direct-path tables, KPI tile 1 shows **"Rows / sec"** with a
  rows-rate sparkline
- When the agent moves on to a staged table, KPI tile 1 swaps to
  **"MB / sec"** and the sparkline starts plotting bytes-rate samples
  from ClickHouse's `system.processes`
- The staged table's row shows an **"S3" pill** next to the name and a
  4-segment phase indicator: `unload → staged → load → validate`
- Milestones panel shows each phase transition with byte totals

If you don't see byte-rate samples appearing during the load phase, see
the troubleshooting section below.

---

## 7. Troubleshooting

### "S3Stage.from_env(): missing env var 'STAGING_S3_BUCKET'"

You haven't set the env vars yet, or you set them after the
`migration-runner` container was created. Re-run
`docker compose up -d --force-recreate migration-runner`.

### Snowflake error: "Specified credentials do not have access to this S3 location"

The IAM policy doesn't grant `s3:PutObject` on the prefix Snowflake is
trying to write to. Double-check:

- The `Resource` ARN in step 3 matches the bucket name exactly
- The prefix in the policy (`migrationkit/*`) matches your
  `STAGING_S3_PREFIX`
- The access key ID in `.env` actually belongs to that IAM user

### Snowflake error: "SQL compilation error: Stage … does not exist"

Shouldn't happen in normal use — `migrationkit` creates the stage
fresh on each table via `CREATE OR REPLACE STAGE` and drops it after.
If it does happen, check Snowflake permissions: the user needs `CREATE
STAGE` on the schema being unloaded from.

### Dashboard shows "MB / sec" tile but the sparkline stays at 0

Most likely: your ClickHouse Cloud user doesn't have visibility into
`system.processes` (or `clusterAllReplicas('default', system.processes)`).
Without that, the in-flight polling can't read `read_bytes`. The load
will still complete correctly — you just lose the live sparkline.

Fix: grant your ClickHouse Cloud user `SELECT` on `system.processes` (or
use a `default`-equivalent role).

### Staged Parquet files left in the bucket after a successful migration

By default `add_table_via_s3(cleanup_staged=True)` deletes the run's
prefix after validation passes. If the migration was cancelled or
failed during loading, cleanup is skipped — partners can keep
investigating the data. Sweep them manually:

```bash
aws s3 rm s3://my-migration-staging/migrationkit/<run_id>/ --recursive
```

Or rely on the bucket lifecycle rule from step 2.

---

## 8. What `migrationkit` actually does

In case you're curious about the exact SQL — for each staged table the
`Migrator` runs:

```sql
-- On Snowflake (issued by migrationkit.sources.snowflake.unload_to_s3):
CREATE OR REPLACE STAGE MK_STAGE_<sanitized_run_id>
  URL = 's3://<bucket>/<prefix>/<run_id>/'
  CREDENTIALS = (AWS_KEY_ID='…' AWS_SECRET_KEY='…')
  FILE_FORMAT = (TYPE = PARQUET);

COPY INTO @MK_STAGE_<…>/<table>/
  FROM <table>
  FILE_FORMAT = (TYPE = PARQUET)
  HEADER = TRUE
  OVERWRITE = TRUE;

DROP STAGE IF EXISTS MK_STAGE_<…>;
```

```sql
-- On ClickHouse Cloud (issued by migrationkit.targets.clickhouse.load_from_s3):
INSERT INTO <target_db>.<target_table>
SELECT * FROM s3(
  's3://<bucket>/<prefix>/<run_id>/<table>/*.parquet',
  '<aws_key>',
  '<aws_secret>',
  'Parquet'
)
SETTINGS query_id = '<uuid>';   -- so the polling thread can find this query
```

While the INSERT runs, a second connection polls every ~2 seconds:

```sql
SELECT read_bytes, total_rows_approx, elapsed
FROM clusterAllReplicas('default', system.processes)
WHERE query_id = '<uuid>'
ORDER BY elapsed DESC LIMIT 1;
```

Each sample becomes a `bytes_progress` event that the dashboard's
sparkline consumes. When the load completes, the library compares
`SELECT count() FROM <target>` against the pre-staged row count from
Snowflake; mismatch = failure. On success, the per-run S3 prefix is
deleted (unless `cleanup_staged=False` was passed).
