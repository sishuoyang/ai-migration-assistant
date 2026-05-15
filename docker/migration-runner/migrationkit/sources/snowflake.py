from __future__ import annotations

import os
import time
from typing import Any, Iterator, TYPE_CHECKING

from .base import Source, UnloadResult

if TYPE_CHECKING:
    from ..staging.s3 import S3Stage


class SnowflakeSource(Source):
    source_type = "snowflake"

    def __init__(
        self,
        account: str,
        user: str,
        password: str,
        warehouse: str | None = None,
        database: str | None = None,
        schema: str | None = None,
        role: str | None = None,
    ) -> None:
        import snowflake.connector

        self.database = database
        self._conn = snowflake.connector.connect(
            account=account,
            user=user,
            password=password,
            warehouse=warehouse,
            database=database,
            schema=schema,
            role=role,
            client_session_keep_alive=True,
        )

    @classmethod
    def from_env(cls) -> "SnowflakeSource":
        return cls(
            account=os.environ["SNOWFLAKE_ACCOUNT"],
            user=os.environ["SNOWFLAKE_USER"],
            password=os.environ["SNOWFLAKE_PASSWORD"],
            warehouse=os.environ.get("SNOWFLAKE_WAREHOUSE") or None,
            database=os.environ.get("SNOWFLAKE_DATABASE") or None,
            schema=os.environ.get("SNOWFLAKE_SCHEMA") or None,
            role=os.environ.get("SNOWFLAKE_ROLE") or None,
        )

    @classmethod
    def list_databases_from_env(cls) -> list[str]:
        """Open a short-lived connection (no specific database) and
        return the names visible to the env credentials. Used by the
        dashboard's source-database dropdown."""
        import snowflake.connector

        conn = snowflake.connector.connect(
            account=os.environ["SNOWFLAKE_ACCOUNT"],
            user=os.environ["SNOWFLAKE_USER"],
            password=os.environ["SNOWFLAKE_PASSWORD"],
            warehouse=os.environ.get("SNOWFLAKE_WAREHOUSE") or None,
            role=os.environ.get("SNOWFLAKE_ROLE") or None,
        )
        try:
            cur = conn.cursor()
            try:
                cur.execute("SHOW DATABASES")
                # SHOW DATABASES returns rows with the database name at index 1.
                return [str(r[1]) for r in cur.fetchall()]
            finally:
                cur.close()
        finally:
            conn.close()

    def count_rows(self, query: str) -> int:
        cur = self._conn.cursor()
        try:
            cur.execute(f"SELECT count(*) FROM ({query})")
            (n,) = cur.fetchone()
            return int(n)
        finally:
            cur.close()

    def execute_and_count(self, sql: str) -> tuple[int, float | None, float]:
        import time
        cur = self._conn.cursor()
        try:
            t0 = time.monotonic()
            cur.execute(sql)
            rows = cur.fetchall()
            wall_ms = (time.monotonic() - t0) * 1000.0
            qid = getattr(cur, "sfqid", None)
        finally:
            cur.close()
        server_ms = self._fetch_server_ms(qid) if qid else None
        return len(rows), server_ms, wall_ms

    def _fetch_server_ms(self, query_id: str) -> float | None:
        """Look up `EXECUTION_TIME` (ms) for the just-completed query
        in `INFORMATION_SCHEMA.QUERY_HISTORY_BY_SESSION()`. Session-
        scoped so latency is typically sub-second; if the row isn't
        visible yet, retry once after 250 ms and then give up
        (caller falls back to wall_ms)."""
        import time as _time
        sql = (
            "SELECT EXECUTION_TIME "
            "FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY_BY_SESSION("
            "RESULT_LIMIT => 100)) "
            f"WHERE QUERY_ID = '{query_id}' LIMIT 1"
        )
        for attempt in range(2):
            try:
                cur = self._conn.cursor()
                try:
                    cur.execute(sql)
                    row = cur.fetchone()
                finally:
                    cur.close()
                if row and row[0] is not None:
                    return float(row[0])
            except Exception:
                return None
            if attempt == 0:
                _time.sleep(0.25)
        return None

    def iter_batches(
        self, query: str, batch_size: int
    ) -> Iterator[list[dict[str, Any]]]:
        cur = self._conn.cursor()
        try:
            cur.execute(query)
            columns = [c[0].lower() for c in cur.description]
            while True:
                rows = cur.fetchmany(batch_size)
                if not rows:
                    return
                yield [dict(zip(columns, r)) for r in rows]
        finally:
            cur.close()

    def unload_to_s3(
        self,
        table: str,
        stage: "S3Stage",
        run_id: str,
        file_format: str = "parquet",
    ) -> UnloadResult:
        """Bulk-export `table` to the per-run S3 prefix via Snowflake
        `COPY INTO @ext_stage`. Snowflake parallelises into ~16 files
        automatically.

        Idempotent: `OVERWRITE = TRUE` and the stage URL is keyed on
        run_id so re-running this table replaces its prior files
        without touching other tables in the run."""
        # Lazy import — avoids a hard dep on the staging package from
        # the source class itself.
        from ..staging.s3 import list_s3_objects

        if file_format.lower() != "parquet":
            raise ValueError(
                f"unload_to_s3: only parquet is supported in v1, got {file_format!r}"
            )

        # Snowflake stage names are restricted to identifiers — sanitize
        # the run_id (which often contains hyphens and a timestamp).
        stage_name = "MK_STAGE_" + _sanitize_identifier(run_id)
        stage_url = stage.s3_uri(run_id, "")  # bucket/prefix/run_id/ (table appended in COPY)

        cur = self._conn.cursor()
        try:
            # Create-or-replace so re-runs always have a fresh stage
            # pointing at the right URL.
            cur.execute(
                f"""
                CREATE OR REPLACE STAGE {stage_name}
                URL = '{stage_url}'
                CREDENTIALS = (
                    AWS_KEY_ID='{stage.access_key_id}'
                    AWS_SECRET_KEY='{stage.secret_access_key}'
                )
                FILE_FORMAT = (TYPE = PARQUET)
                """
            )
            t0 = time.monotonic()
            cur.execute(
                f"""
                COPY INTO @{stage_name}/{table}/
                FROM {table}
                FILE_FORMAT = (TYPE = PARQUET)
                HEADER = TRUE
                OVERWRITE = TRUE
                """
            )
            seconds = round(time.monotonic() - t0, 3)
            # Always drop the stage — files in S3 are independent of it.
            cur.execute(f"DROP STAGE IF EXISTS {stage_name}")
        finally:
            cur.close()

        files = list_s3_objects(stage, run_id, table)
        total_bytes = sum(f.size for f in files)
        return UnloadResult(
            file_count=len(files),
            total_bytes=total_bytes,
            seconds=seconds,
        )

    def close(self) -> None:
        try:
            self._conn.close()
        except Exception:
            pass


def _sanitize_identifier(s: str) -> str:
    """Snowflake unquoted identifiers can only contain letters, digits,
    underscores. Map anything else to underscore."""
    return "".join(c if c.isalnum() or c == "_" else "_" for c in s)
