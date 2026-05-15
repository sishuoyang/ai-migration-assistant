# BigQuery Terraform module (Setup Path B)

This module provisions a BigQuery demo environment in your existing GCP
project (or a fresh one) and writes the service-account key the
`bigquery-source` MCP container needs.

Creates:
- BigQuery dataset (default `migration_demo`, location `US`)
- Service account `migration-demo-sa@<project>.iam.gserviceaccount.com`
  with `roles/bigquery.dataEditor` + `roles/bigquery.jobUser` on the
  project
- Service-account key written to `./secrets/gcp-key.json` (project root),
  used both by the MCP container and by the migration-runner Python
  scripts
- (Optional) GCS staging bucket with 7-day lifecycle deletion, granted
  `roles/storage.objectAdmin` to the SA — for the agent's Path 2
  bulk-export migration mode

Teardown is one `terraform destroy`.

## Operating modes

| Mode       | `existing_project_id` | `billing_account_id` | Behaviour |
|------------|-----------------------|----------------------|-----------|
| Attach     | set to your project   | unused               | Use the existing project; create dataset + SA inside it |
| Greenfield | leave `null`          | required             | Create a new project under the billing account, enable BigQuery + Storage APIs, then create dataset + SA |

Attach mode is what most partners want — a sandbox project they already
have admin on. Greenfield mode is useful for ephemeral demos in
shared-tenancy GCP orgs.

## Requirements

- `terraform` CLI ≥ 1.5
- `gcloud` authenticated as a user with:
  - **Attach mode:** BigQuery Admin + IAM Admin on the target project
  - **Greenfield mode:** Project Creator + Billing Account User on the
    target billing account

## Usage

```bash
cd sources/bigquery/terraform
cp terraform.tfvars.example terraform.tfvars
# Edit: existing_project_id (attach) OR billing_account_id (greenfield)

# Authenticate Terraform's Google provider with your user creds:
gcloud auth application-default login

terraform init
terraform apply
```

Expected runtime: ~30 seconds (attach) or ~2 minutes (greenfield, API
enable is the slow step).

## Capture the credentials

```bash
terraform output -no-color -raw env_block 2>/dev/null \
  | grep -E '^(#|[A-Z_]+=|$)' >> ../../../.env
```

The `grep` filter discards any non-env-var lines that terraform might
emit alongside the block — e.g. a "No outputs found" warning on a
half-applied state — so only valid `KEY=value` lines reach `.env`.

The `env_block` output contains `BIGQUERY_PROJECT`, `BIGQUERY_DATASET`,
`BIGQUERY_LOCATION`, `BIGQUERY_KEY_FILE`, and (if `create_staging_bucket`
was true) the `STAGING_GCS_*` block. The SA key has already been written
to `./secrets/gcp-key.json` — both the `bigquery-source` MCP container
and `migration-runner` mount that path at `/secrets/gcp-key.json`.

## Loading the workload

After `terraform apply` succeeds, populate the dataset with the TPC-H
workload:

```bash
cd ../../..   # back to repo root
make tpch-data           # generate SF1 .tbl files (~30 s)
make tpch-load-bigquery  # load + augment into BigQuery (~5 min)
```

Then follow Phase 1 of [../GUIDE.md](../GUIDE.md).

## Teardown

```bash
terraform destroy
```

In attach mode this drops the dataset, SA, and optional bucket. In
greenfield mode it also schedules the project for deletion (30-day
grace per GCP's standard policy).

## Notes

- The SA key is written to `./secrets/gcp-key.json` relative to this
  module's path, which resolves to the repo root's `secrets/` directory.
  `secrets/` is git-ignored — never commit this file.
- The optional GCS staging bucket has a 7-day lifecycle rule, so any
  Parquet files the agent's Path 2 leaves behind get cleaned up
  automatically.
