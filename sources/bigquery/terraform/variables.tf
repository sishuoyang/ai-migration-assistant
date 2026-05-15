variable "existing_project_id" {
  description = <<EOT
GCP project ID to attach to. If null, Terraform creates a fresh project
under `billing_account_id` (greenfield mode). Most partners want attach
mode against an existing sandbox project.
EOT
  type    = string
  default = null
}

variable "billing_account_id" {
  description = <<EOT
GCP billing account ID, required in greenfield mode (when
`existing_project_id` is null). Ignored in attach mode.
EOT
  type    = string
  default = null
}

variable "region" {
  description = "Default GCP region for the provider — only affects the project location in greenfield mode."
  type        = string
  default     = "us-central1"
}

variable "location" {
  description = "BigQuery dataset location (and GCS bucket location if create_staging_bucket=true)."
  type        = string
  default     = "US"
}

variable "dataset_name" {
  description = "BigQuery dataset to create. Must be a valid BigQuery dataset name."
  type        = string
  default     = "migration_demo"
}

variable "create_staging_bucket" {
  description = "Create a GCS bucket for the agent's Path 2 (bulk export) workflow."
  type        = bool
  default     = false
}
