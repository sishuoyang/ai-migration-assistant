# Snowflake Terraform module (Setup Path B)

This module provisions a dedicated demo environment in your existing Snowflake
account and sets up the `MIGRATION_DEMO.RETAIL` workload (TPC-H tables +
Snowflake-specific augmentations), all in one `terraform apply`.

Creates:
- Warehouse `MIGRATION_DEMO_WH` (X-SMALL, auto-suspend 60s)
- Database `MIGRATION_DEMO`, schema `RETAIL`
- Role `MIGRATION_DEMO_ROLE` with USAGE on the warehouse + database + schema,
  SELECT on future tables, and IMPORTED PRIVILEGES on `SNOWFLAKE_SAMPLE_DATA`
- User `AI_MIGRATION_DEMO` with a random 32-char password
- Runs `setup_workload.py` to copy 8 TPC-H tables and apply 5 Snowflake-
  specific augmentations (VARIANT column, TIMESTAMP_TZ column, Clustering
  Key, Stream, Dynamic Table).

Teardown is one `terraform destroy`.

## Requirements

- `terraform` CLI ≥ 1.5
- `python3` with `snowflake-connector-python` installed (Terraform calls
  `python3 ../scripts/setup_workload.py` from a `null_resource`)
- A Snowflake account with ACCOUNTADMIN access (or equivalent)

## Usage

```bash
cd sources/snowflake/terraform
cp terraform.tfvars.example terraform.tfvars
# Edit: snowflake_account, admin_user, admin_password

terraform init
terraform apply
```

Expected runtime: ~1 minute (workload setup dominates, ~30s).

## Optional: provision the S3 staging bucket

For tables larger than ~1M rows, the bulk-export path
(`Migrator.add_table_via_s3`) is ~10× faster than the direct iterator. It
needs an S3 bucket + a scoped IAM user that Snowflake's `COPY INTO @stage`
authenticates to with inline credentials. Pass `-var=create_staging_bucket=true`
and the module provisions the AWS side too:

```bash
# AWS credentials must be in the shell — standard provider chain:
#   AWS_PROFILE=my-sandbox        (named profile in ~/.aws/credentials)
# or:
#   export AWS_ACCESS_KEY_ID=...
#   export AWS_SECRET_ACCESS_KEY=...
#   export AWS_SESSION_TOKEN=...   (optional, for assumed-role / SSO)

terraform apply -var=create_staging_bucket=true -var=aws_region=us-east-1
```

This adds an `aws_s3_bucket` (`force_destroy=true` so teardown is clean),
a 7-day lifecycle rule, a blocked-public-access policy, and an
`aws_iam_user` with PutObject/GetObject/DeleteObject on the
`<bucket>/migrationkit/*` prefix plus ListBucket on the bucket. The
`env_block` output then includes five extra lines:
`STAGING_S3_BUCKET`, `STAGING_S3_REGION`, `STAGING_S3_PREFIX`,
`STAGING_S3_ACCESS_KEY_ID`, `STAGING_S3_SECRET_ACCESS_KEY` — the same
filter below preserves them.

Two layers of AWS auth to keep straight:

| Layer | When | Auth source |
|---|---|---|
| **Build-time** (terraform apply) | You, running `terraform apply` | Your AWS credentials from the standard chain |
| **Runtime** (`migration-runner`) | At chat time, when Snowflake `COPY INTO @stage` writes to the bucket | The bucket-scoped access key in `env_block` |

If you prefer to BYO an S3 bucket and IAM user, leave `create_staging_bucket=false`
(the default) and follow the manual walkthrough in
[../../../docs/object-storage-staging.md](../../../docs/object-storage-staging.md).

## Capture the credentials

```bash
terraform output -no-color -raw env_block 2>/dev/null \
  | grep -E '^(#|[A-Z_]+=|$)' >> ../../../.env
```

(The `grep` filter discards any non-env-var lines that terraform might
emit alongside the block — e.g. a warning on a half-applied state —
so only valid `KEY=value` lines reach `.env`. It preserves the
`STAGING_S3_*` lines if you enabled the staging bucket.)

Then follow Phase 1 of [../GUIDE.md](../GUIDE.md).

## Teardown

```bash
terraform destroy
```

Drops the warehouse, database (and everything in it), role, and user.

## Notes

- The `null_resource.setup_workload` triggers on `filemd5()` of both
  `setup_workload.py` and `setup_workload.sql`, so editing either causes a
  re-run on the next `terraform apply`. To force a manual re-run:
  `terraform apply -replace=null_resource.setup_workload`.
- The demo user only has SELECT on the schema's tables. The setup script
  runs as the admin user so it can copy from `SNOWFLAKE_SAMPLE_DATA`.
