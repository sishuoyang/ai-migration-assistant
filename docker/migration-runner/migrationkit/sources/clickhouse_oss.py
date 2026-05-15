from __future__ import annotations

import os
import time
from typing import Any, Iterator, TYPE_CHECKING

from .base import Source, UnloadResult

if TYPE_CHECKING:
    from ..staging.s3 import S3Stage


class ClickHouseOssSource(Source):
    source_type = "clickhouse_oss"

    def __init__(
        self,
        host: str,
        port: int,
        user: str,
        password: str,
        database: str,
    ) -> None:
        import clickhouse_connect

        self.database = database
        self._client = clickhouse_connect.get_client(
            host=host, port=port, username=user, password=password, database=database
        )

    @classmethod
    def from_env(cls) -> "ClickHouseOssSource":
        return cls(
            host=os.environ.get("CH_OSS_HOST", "clickhouse-oss"),
            port=int(os.environ.get("CH_OSS_PORT", "8123")),
            user=os.environ.get("CH_OSS_USER", "default"),
            password=os.environ.get("CH_OSS_PASSWORD", ""),
            database=os.environ.get("CH_OSS_DB", "default"),
        )

    @classmethod
    def list_databases_from_env(cls) -> list[str]:
        """`SHOW DATABASES` on the OSS server. Filters out the always-
        present system databases that aren't migration targets."""
        import clickhouse_connect

        host = os.environ.get("CH_OSS_HOST", "clickhouse-oss")
        # Common .env trap: `CH_OSS_HOST=localhost` works on the partner's
        # laptop (via the host port-forward) but never inside the
        # migration-runner container. Surface a clear hint instead of a
        # raw "Connection refused" that buries the cause.
        if host in ("localhost", "127.0.0.1"):
            raise RuntimeError(
                "CH_OSS_HOST is set to 'localhost' in .env, which never "
                "works inside the migration-runner container — there's "
                "no ClickHouse OSS server on the container's own "
                "loopback. Either unset CH_OSS_HOST (let the default "
                "'clickhouse-oss' Docker service name kick in) or set it "
                "to your real CH OSS hostname. See .env.example."
            )

        client = clickhouse_connect.get_client(
            host=host,
            port=int(os.environ.get("CH_OSS_PORT", "8123")),
            username=os.environ.get("CH_OSS_USER", "default"),
            password=os.environ.get("CH_OSS_PASSWORD", ""),
            database="default",
        )
        try:
            rows = client.query("SHOW DATABASES").result_rows
            SYSTEM = {"system", "INFORMATION_SCHEMA", "information_schema"}
            return [r[0] for r in rows if r[0] not in SYSTEM]
        finally:
            client.close()

    def count_rows(self, query: str) -> int:
        result = self._client.query(f"SELECT count() FROM ({query})")
        return int(result.first_row[0])

    def execute_and_count(self, sql: str) -> tuple[int, float | None, float]:
        import time
        t0 = time.monotonic()
        result = self._client.query(sql)
        rows = result.result_rows  # forces full fetch
        wall_ms = (time.monotonic() - t0) * 1000.0
        # `result.summary` is the parsed X-ClickHouse-Summary header.
        # `elapsed_ns` is the server's own execution timer for the query —
        # excludes HTTP transit + result transfer, so it's network-neutral.
        elapsed_ns = result.summary.get("elapsed_ns") if result.summary else None
        server_ms = float(elapsed_ns) / 1e6 if elapsed_ns else None
        return len(rows), server_ms, wall_ms

    def iter_batches(
        self, query: str, batch_size: int
    ) -> Iterator[list[dict[str, Any]]]:
        # clickhouse-connect's query_rows_stream returns a context manager
        # that yields rows lazily without loading all into memory.
        with self._client.query_rows_stream(query) as stream:
            columns = [c.lower() for c in stream.source.column_names]
            batch: list[dict[str, Any]] = []
            for row in stream:
                batch.append(dict(zip(columns, row)))
                if len(batch) >= batch_size:
                    yield batch
                    batch = []
            if batch:
                yield batch

    def unload_to_s3(
        self,
        table: str,
        stage: "S3Stage",
        run_id: str,
        file_format: str = "parquet",
    ) -> UnloadResult:
        """Bulk-export `table` to the per-run S3 prefix via ClickHouse's
        `INSERT INTO FUNCTION s3(...)` write target. Produces a single
        parquet file per table (CH OSS doesn't auto-shard like Snowflake;
        for the ~5–10M row tables this workload targets a single file
        loads fast on the read side).

        Idempotent: `s3_truncate_on_insert=1` lets re-runs overwrite the
        file without manual cleanup, and the URL is keyed on run_id so
        re-running this table doesn't touch other tables in the run."""
        # Lazy import — keeps boto3 out of the direct-path import graph.
        from ..staging.s3 import list_s3_objects

        if file_format.lower() != "parquet":
            raise ValueError(
                f"unload_to_s3: only parquet is supported in v1, got {file_format!r}"
            )

        # `s3_uri` returns `s3://<bucket>/<prefix>/<run_id>/<table>/` with
        # a trailing slash; append a single filename — the read-side glob
        # `*.parquet` matches it.
        s3_url = stage.s3_uri(run_id, table) + "data.parquet"

        t0 = time.monotonic()
        self._client.command(
            f"""
            INSERT INTO FUNCTION s3(
                '{s3_url}',
                '{stage.access_key_id}',
                '{stage.secret_access_key}',
                'Parquet'
            ) SETTINGS s3_truncate_on_insert=1
            SELECT * FROM {table}
            """
        )
        seconds = round(time.monotonic() - t0, 3)

        files = list_s3_objects(stage, run_id, table)
        total_bytes = sum(f.size for f in files)
        return UnloadResult(
            file_count=len(files),
            total_bytes=total_bytes,
            seconds=seconds,
        )

    def close(self) -> None:
        try:
            self._client.close()
        except Exception:
            pass
