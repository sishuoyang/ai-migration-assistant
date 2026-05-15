variable "snowflake_account" {
  description = "Snowflake account identifier in the form ORGNAME-ACCOUNTNAME (e.g. ABCDEFG-XY12345)."
  type        = string
}

variable "admin_user" {
  description = "Snowflake user with ACCOUNTADMIN (or equivalent) to provision the demo environment."
  type        = string
}

variable "admin_password" {
  description = "Password for the admin user."
  type        = string
  sensitive   = true
}

variable "admin_role" {
  description = "Role of the admin user. Needs ACCOUNTADMIN to create warehouses + users + roles."
  type        = string
  default     = "ACCOUNTADMIN"
}

variable "warehouse_size" {
  description = "Size of the dedicated demo warehouse."
  type        = string
  default     = "X-SMALL"
}

variable "create_staging_bucket" {
  description = "Create an S3 bucket + scoped IAM user for the Snowflake → S3 → ClickHouse Cloud bulk-export path (Migrator.add_table_via_s3). Requires AWS credentials in the shell environment at terraform-apply time."
  type        = bool
  default     = false
}

variable "aws_region" {
  description = "AWS region for the staging S3 bucket. Ignored when create_staging_bucket=false. Choose a region close to your Snowflake account and ClickHouse Cloud service."
  type        = string
  default     = "us-east-1"
}
