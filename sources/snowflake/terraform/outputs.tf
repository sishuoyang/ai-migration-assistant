output "env_block" {
  description = "Paste this block into the project's .env file."
  sensitive   = true
  value       = <<EOT

# ── Snowflake Source (provisioned by terraform) ──────────────
SNOWFLAKE_ACCOUNT=${var.snowflake_account}
SNOWFLAKE_USER=${snowflake_user.demo.name}
SNOWFLAKE_PASSWORD=${random_password.demo_user.result}
SNOWFLAKE_ROLE=${snowflake_account_role.demo.name}
SNOWFLAKE_WAREHOUSE=${snowflake_warehouse.demo.name}
${var.create_staging_bucket ? "STAGING_S3_BUCKET=${aws_s3_bucket.staging[0].bucket}\nSTAGING_S3_REGION=${var.aws_region}\nSTAGING_S3_PREFIX=migrationkit\nSTAGING_S3_ACCESS_KEY_ID=${aws_iam_access_key.staging[0].id}\nSTAGING_S3_SECRET_ACCESS_KEY=${aws_iam_access_key.staging[0].secret}" : "# (no S3 staging — set create_staging_bucket=true to provision one)"}
EOT
}

output "summary" {
  description = "Human-readable summary of what was created."
  value = {
    warehouse      = snowflake_warehouse.demo.name
    database       = snowflake_database.demo.name
    schema         = snowflake_schema.retail.name
    role           = snowflake_account_role.demo.name
    user           = snowflake_user.demo.name
    staging_bucket = var.create_staging_bucket ? aws_s3_bucket.staging[0].bucket : null
  }
}
