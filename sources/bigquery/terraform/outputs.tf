output "env_block" {
  description = "Paste this block into the project's .env file."
  sensitive   = true
  value = <<EOT

# ── BigQuery Source (provisioned by terraform) ───────────────
BIGQUERY_PROJECT=${local.project_id}
BIGQUERY_DATASET=${google_bigquery_dataset.demo.dataset_id}
BIGQUERY_LOCATION=${var.location}
BIGQUERY_KEY_FILE=./secrets/gcp-key.json
${var.create_staging_bucket ? "STAGING_GCS_BUCKET=${google_storage_bucket.staging[0].name}\nSTAGING_GCS_PROJECT=${local.project_id}\nSTAGING_GCS_PREFIX=migrationkit\nSTAGING_GCS_KEY_FILE=./secrets/gcp-key.json\nSTAGING_GCS_ACCESS_KEY_ID=${google_storage_hmac_key.staging[0].access_id}\nSTAGING_GCS_SECRET_ACCESS_KEY=${google_storage_hmac_key.staging[0].secret}" : "# (no GCS staging — set create_staging_bucket=true to provision one)"}
EOT
}

output "summary" {
  description = "Human-readable summary of what was created."
  value = {
    project_id       = local.project_id
    dataset          = google_bigquery_dataset.demo.dataset_id
    service_account  = google_service_account.demo.email
    key_file         = local_sensitive_file.key.filename
    staging_bucket   = var.create_staging_bucket ? google_storage_bucket.staging[0].name : null
  }
}
