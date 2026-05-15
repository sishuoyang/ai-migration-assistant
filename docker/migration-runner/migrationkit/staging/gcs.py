"""
GCS staging primitives — mirrors `staging/s3.py` for the BigQuery →
ClickHouse Cloud path.

Three pieces of auth in play, deliberately separated:

1. **BigQuery `EXPORT DATA`** writes Parquet/CSV files into the
   bucket. Authenticates via the same service-account JSON the
   `BigQuerySource` uses (`GOOGLE_APPLICATION_CREDENTIALS` /
   `STAGING_GCS_KEY_FILE`). The SA needs `roles/storage.objectAdmin`
   on the bucket.
2. **ClickHouse Cloud `gcs()` table function** reads those files.
   It authenticates with **HMAC** credentials, not the SA JSON —
   ClickHouse's `gcs()` only accepts HMAC. Partners create the keys
   via `gcloud iam service-accounts hmac-keys create` against the
   migration SA, then drop `STAGING_GCS_ACCESS_KEY_ID` /
   `STAGING_GCS_SECRET_ACCESS_KEY` into `.env`.
3. **Cleanup** (`list`, `delete`) uses the SA JSON via
   `google-cloud-storage`.

`google-cloud-storage` is imported lazily so non-GCS migrations don't
pay the import cost.
"""
from __future__ import annotations

import os
from dataclasses import dataclass


@dataclass(frozen=True)
class GCSStage:
    """Single source of truth for the GCS staging path: bucket + prefix
    plus both auth surfaces (SA JSON for BigQuery + cleanup, HMAC for
    ClickHouse Cloud reads)."""

    bucket: str
    hmac_access_key_id: str
    hmac_secret_access_key: str
    key_file: str = ""        # SA JSON path; "" means rely on ADC
    prefix: str = "migrationkit"
    project: str = ""

    @classmethod
    def from_env(cls) -> "GCSStage":
        """Read `STAGING_GCS_*` env vars. `STAGING_GCS_KEY_FILE` and
        `STAGING_GCS_PROJECT` fall back to the BigQuery source's
        equivalents so the partner only has to set one set of GCP
        credentials. Raises with an actionable message when a required
        variable is missing."""
        try:
            return cls(
                bucket=os.environ["STAGING_GCS_BUCKET"],
                hmac_access_key_id=os.environ["STAGING_GCS_ACCESS_KEY_ID"],
                hmac_secret_access_key=os.environ["STAGING_GCS_SECRET_ACCESS_KEY"],
                # Prefer GOOGLE_APPLICATION_CREDENTIALS over
                # BIGQUERY_KEY_FILE — the former is reliably absolute
                # (docker-compose injects /secrets/gcp-key.json), while
                # the latter is host-relative (./secrets/gcp-key.json)
                # and fails when cwd != repo root, e.g. inside the
                # migration-runner container where cwd is /workspace.
                key_file=(
                    os.environ.get("STAGING_GCS_KEY_FILE")
                    or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
                    or os.environ.get("BIGQUERY_KEY_FILE")
                    or ""
                ),
                prefix=os.environ.get("STAGING_GCS_PREFIX", "migrationkit"),
                project=(
                    os.environ.get("STAGING_GCS_PROJECT")
                    or os.environ.get("BIGQUERY_PROJECT")
                    or ""
                ),
            )
        except KeyError as missing:
            raise RuntimeError(
                f"GCSStage.from_env(): missing env var {missing}. Set "
                "STAGING_GCS_BUCKET, STAGING_GCS_ACCESS_KEY_ID, "
                "STAGING_GCS_SECRET_ACCESS_KEY (HMAC keys — create via "
                "`gcloud iam service-accounts hmac-keys create "
                "--service-account-email <sa-email>`). "
                "STAGING_GCS_KEY_FILE, STAGING_GCS_PREFIX, and "
                "STAGING_GCS_PROJECT are optional. See "
                "docs/object-storage-staging.md."
            ) from None

    def gs_uri(self, run_id: str, table: str) -> str:
        """`gs://<bucket>/<prefix>/<run_id>/<table>/` — trailing slash.
        Used by BigQuery's `EXPORT DATA OPTIONS(uri=…)`."""
        clean_prefix = self.prefix.strip("/")
        parts = [p for p in [clean_prefix, run_id, table] if p]
        return f"gs://{self.bucket}/{'/'.join(parts)}/"

    def gcs_glob(
        self, run_id: str, table: str, file_format: str = "parquet"
    ) -> str:
        """`https://storage.googleapis.com/<bucket>/<prefix>/<run_id>/<table>/*.<fmt>`
        — wildcard URI consumed by ClickHouse's `gcs()` table function.
        ClickHouse Cloud needs the HTTPS form, not `gs://`."""
        ext = file_format.lower()
        clean_prefix = self.prefix.strip("/")
        parts = [p for p in [clean_prefix, run_id, table] if p]
        return (
            f"https://storage.googleapis.com/{self.bucket}/"
            f"{'/'.join(parts)}/*.{ext}"
        )

    def key_prefix(self, run_id: str, table: str) -> str:
        """Just the object-key portion (no scheme / bucket), trailing
        slash. Used by `list_blobs` / `delete_blob`."""
        clean_prefix = self.prefix.strip("/")
        parts = [p for p in [clean_prefix, run_id, table] if p]
        return "/".join(parts) + "/"


@dataclass(frozen=True)
class GCSObject:
    key: str
    size: int


def _client(stage: GCSStage):
    """Lazy `google.cloud.storage.Client` — imported here, not at
    module top, so direct-path migrations don't import it."""
    from google.cloud import storage  # noqa: PLC0415

    if stage.key_file:
        return storage.Client.from_service_account_json(stage.key_file)
    # Fall back to ADC (gcloud auth application-default login).
    return storage.Client(project=stage.project or None)


def list_gcs_objects(
    stage: GCSStage, run_id: str, table: str
) -> list[GCSObject]:
    """All objects under `<prefix>/<run_id>/<table>/`. Used after
    `BigQuerySource.unload_to_gcs` to report file_count / total_bytes,
    and as the cleanup driver."""
    client = _client(stage)
    prefix = stage.key_prefix(run_id, table)
    bucket = client.bucket(stage.bucket)
    out: list[GCSObject] = []
    for blob in bucket.list_blobs(prefix=prefix):
        out.append(GCSObject(key=blob.name, size=int(blob.size or 0)))
    return out


def delete_gcs_prefix(stage: GCSStage, run_id: str, table: str) -> int:
    """Delete every object under the per-run-per-table prefix. Returns
    the count deleted. `google-cloud-storage` doesn't have a batched
    multi-object delete API as clean as S3's, but `Client.batch()`
    pipelines the HTTP requests so 1000 objects come down to a handful
    of round-trips."""
    client = _client(stage)
    bucket = client.bucket(stage.bucket)
    objects = list_gcs_objects(stage, run_id, table)
    if not objects:
        return 0
    # Pipeline in groups of 100 — Google's batch API caps individual
    # batches at 100 sub-requests.
    for batch_start in range(0, len(objects), 100):
        chunk = objects[batch_start : batch_start + 100]
        with client.batch():
            for o in chunk:
                bucket.delete_blob(o.key)
    return len(objects)
