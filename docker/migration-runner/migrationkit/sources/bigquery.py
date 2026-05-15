"""
BigQuery source for migrationkit.

Connects via `google-cloud-bigquery`, picks up Application Default
Credentials from `GOOGLE_APPLICATION_CREDENTIALS` (Path-B Terraform
writes the service-account key to `./secrets/gcp-key.json` and the
migration-runner container mounts it at `/secrets/gcp-key.json`).

A BigQuery "dataset" plays the role of "database" elsewhere in
migrationkit — same shape (a namespace that contains tables) and same
plumbing: the partner picks one from the dashboard dropdown, and the
prompt's `{database}` substitution becomes the dataset name.

If `BIGQUERY_DATASET` is set, the client's `default_dataset` is
configured so the agent can write bare-name queries like
`SELECT * FROM <table>`. If not, queries must be fully qualified
(`SELECT * FROM \\`<project>.<dataset>.<table>\\``).
"""
from __future__ import annotations

import os
from typing import Any, Iterator


class BigQuerySource:
    """BigQuery read interface for `Migrator`, `Validator`, and
    `Benchmarker`."""

    source_type: str = "bigquery"

    def __init__(
        self,
        project: str,
        dataset: str | None = None,
        location: str = "US",
    ) -> None:
        from google.cloud import bigquery

        if not project:
            raise ValueError("BigQuerySource: project is required")

        self.project = project
        self.dataset = dataset or None
        # `database` is what Migrator/Validator/Benchmarker read off the
        # source — mirror the convention used by SnowflakeSource /
        # PostgresSource / ClickHouseOssSource so the rest of the
        # plumbing doesn't care which source it's talking to.
        self.database = self.dataset
        self.location = location

        # google-cloud-bigquery picks up GOOGLE_APPLICATION_CREDENTIALS
        # automatically — no explicit credential param needed here.
        self._client = bigquery.Client(project=project, location=location)
        # Job-config default applied to every query so bare table names
        # resolve against the partner's chosen dataset.
        self._default_dataset_ref = (
            bigquery.DatasetReference(project, self.dataset)
            if self.dataset
            else None
        )

    # ── construction helpers ─────────────────────────────────────────

    @classmethod
    def from_env(cls) -> "BigQuerySource":
        """Required env: `BIGQUERY_PROJECT`. Optional:
        `BIGQUERY_DATASET` (seeds default_dataset for bare-name queries)
        and `BIGQUERY_LOCATION` (defaults to `US`)."""
        try:
            project = os.environ["BIGQUERY_PROJECT"]
        except KeyError as missing:
            raise KeyError(
                f"BIGQUERY_PROJECT is required to construct BigQuerySource "
                f"({missing})"
            ) from None
        return cls(
            project=project,
            dataset=os.environ.get("BIGQUERY_DATASET") or None,
            location=os.environ.get("BIGQUERY_LOCATION", "US"),
        )

    @classmethod
    def list_databases_from_env(cls) -> list[str]:
        """Enumerate every dataset visible to the configured project's
        service account. Backs the dashboard's source-database
        dropdown."""
        from google.cloud import bigquery

        try:
            project = os.environ["BIGQUERY_PROJECT"]
        except KeyError as missing:
            raise KeyError(
                f"BIGQUERY_PROJECT is required to enumerate BigQuery "
                f"datasets ({missing})"
            ) from None

        client = bigquery.Client(project=project)
        try:
            return sorted(
                d.dataset_id
                for d in client.list_datasets(project=project)
            )
        finally:
            try:
                client.close()
            except Exception:
                pass

    # ── Source ABC contract ──────────────────────────────────────────

    def count_rows(self, query: str) -> int:
        sql = f"SELECT COUNT(*) FROM ({query})"
        result = self._client.query(
            sql, job_config=self._job_config()
        ).result()
        return int(next(iter(result))[0])

    def iter_batches(
        self, query: str, batch_size: int
    ) -> Iterator[list[dict[str, Any]]]:
        job = self._client.query(query, job_config=self._job_config())
        rows = job.result(page_size=batch_size)
        batch: list[dict[str, Any]] = []
        for row in rows:
            # row is a bigquery.Row — dict(row) preserves the schema
            # field names. Lowercase to line up with the convention
            # used by the other sources (ClickHouse target columns are
            # lowercase by default).
            batch.append({k.lower(): v for k, v in dict(row).items()})
            if len(batch) >= batch_size:
                yield batch
                batch = []
        if batch:
            yield batch

    def execute_and_count(self, sql: str) -> tuple[int, float | None, float]:
        """Return `(rows, server_ms, wall_ms)`. server_ms is BigQuery's
        own job runtime, populated server-side and network-neutral.

        We use `(job.ended - job.started)` rather than
        `(job.ended - job.created)` because BigQuery's `start_time` is
        set on the PENDING → RUNNING state transition (per BigQuery API
        docs: https://cloud.google.com/bigquery/docs/reference/rest/v2/Job#jobstatistics).
        That makes server_ms a wall-clock execution measurement —
        directly comparable to Snowflake's EXECUTION_TIME and
        ClickHouse's elapsed_ns.

        Note: `job.slot_millis` (cumulative slot-time across parallel
        work) is a *different* metric — useful for cost analysis but
        NOT comparable to other engines' wall-clock execution time. The
        benchmark schema is currently single-metric per side; exposing
        slot_millis as a complementary metric would need a state.py
        schema migration."""
        import time

        t0 = time.monotonic()
        job = self._client.query(sql, job_config=self._job_config())
        result = job.result()
        rows = list(result)
        wall_ms = (time.monotonic() - t0) * 1000.0
        server_ms: float | None = None
        if getattr(job, "started", None) and getattr(job, "ended", None):
            server_ms = (job.ended - job.started).total_seconds() * 1000.0
        return len(rows), server_ms, wall_ms

    def close(self) -> None:
        try:
            self._client.close()
        except Exception:
            pass

    # ── GCS staging path ─────────────────────────────────────────────

    def unload_to_gcs(
        self,
        table: str,
        stage,  # GCSStage — kept loose to keep staging/gcs.py off this module's import path
        run_id: str,
        file_format: str = "parquet",
    ):
        """Bulk-export `table` to GCS via BigQuery's `EXPORT DATA`.

        Result lands as a set of Parquet (or CSV) files under
        `gs://<bucket>/<prefix>/<run_id>/<table>/`, which
        `ClickHouseTarget.load_from_gcs(...)` then ingests via
        `INSERT FROM gcs(...)`. The unload uses the same SA the
        BigQuerySource was constructed with; the SA needs
        `roles/storage.objectAdmin` on the bucket."""
        import time

        from ..sources.base import UnloadResult
        from ..staging.gcs import list_gcs_objects

        fmt = file_format.upper()
        if fmt not in ("PARQUET", "CSV"):
            raise ValueError(
                f"unload_to_gcs: unsupported format {file_format!r}; "
                f"supported: parquet, csv"
            )

        # BigQuery's EXPORT DATA wants the destination URI as a glob
        # so it can shard the output across files (~1 GB per shard for
        # PARQUET). The `gs://.../<table>/*.parquet` pattern shards
        # automatically.
        uri = stage.gs_uri(run_id, table).rstrip("/") + f"/*.{file_format.lower()}"

        # Source-table reference. If the caller-supplied table is
        # already fully qualified, use it as-is; otherwise qualify with
        # the constructor's project/dataset.
        if "." in table or "`" in table:
            # Trust the caller.
            table_ref = table if table.startswith("`") else f"`{table}`"
        elif self.dataset:
            table_ref = f"`{self.project}.{self.dataset}.{table}`"
        else:
            raise RuntimeError(
                f"unload_to_gcs: bare table {table!r} and no dataset "
                f"configured on the source — set BIGQUERY_DATASET or "
                f"pass a fully-qualified `project.dataset.table` name."
            )

        # SNAPPY is BigQuery's default Parquet compression and is what
        # ClickHouse's gcs() expects out of the box; setting it
        # explicitly avoids relying on the default.
        compression_clause = (
            "compression='SNAPPY'," if fmt == "PARQUET" else ""
        )
        sql = f"""
            EXPORT DATA OPTIONS(
                uri='{uri}',
                format='{fmt}',
                {compression_clause}
                overwrite=true
            ) AS SELECT * FROM {table_ref}
        """

        t0 = time.monotonic()
        # The EXPORT job uses the connector's SA — same one the rest
        # of the BigQuerySource queries use. No special job_config needed.
        self._client.query(sql).result()
        seconds = time.monotonic() - t0

        # List exported objects to get file_count + total_bytes.
        # `list_gcs_objects` uses the SA from the stage's key_file
        # (which defaults to BIGQUERY_KEY_FILE — i.e. the same SA).
        objs = list_gcs_objects(stage, run_id, table)
        return UnloadResult(
            file_count=len(objs),
            total_bytes=sum(o.size for o in objs),
            seconds=round(seconds, 3),
        )

    # ── internals ────────────────────────────────────────────────────

    def _job_config(self):
        """Return a fresh QueryJobConfig with `default_dataset` set so
        bare table references resolve against the partner's dataset.
        Returns None when no dataset is configured — the agent's query
        must be fully qualified in that case."""
        from google.cloud import bigquery

        if self._default_dataset_ref is None:
            return None
        return bigquery.QueryJobConfig(
            default_dataset=self._default_dataset_ref,
        )
