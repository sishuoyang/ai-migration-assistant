from __future__ import annotations

import os
from typing import Any, Iterator

from .base import Source


class PostgresSource(Source):
    source_type = "postgres"

    def __init__(
        self,
        host: str,
        port: int,
        user: str,
        password: str,
        database: str,
    ) -> None:
        import psycopg2
        import psycopg2.extras

        self.database = database
        self._conn = psycopg2.connect(
            host=host, port=port, user=user, password=password, dbname=database
        )
        self._psycopg2 = psycopg2

    @classmethod
    def from_env(cls) -> "PostgresSource":
        return cls(
            host=os.environ.get("POSTGRES_HOST", "postgres"),
            port=int(os.environ.get("POSTGRES_PORT", "5432")),
            user=os.environ.get("POSTGRES_USER", "playground"),
            password=os.environ.get("POSTGRES_PASSWORD", "playground"),
            database=os.environ.get("POSTGRES_DB", "ecommerce"),
        )

    @classmethod
    def list_databases_from_env(cls) -> list[str]:
        """Connect to the default `postgres` system DB and list all
        non-template, non-system databases. Excludes templates and
        the internal `postgres` maintenance DB."""
        import psycopg2

        host = os.environ.get("POSTGRES_HOST", "postgres")
        if host in ("localhost", "127.0.0.1"):
            raise RuntimeError(
                "POSTGRES_HOST is set to 'localhost' in .env, which "
                "never works inside the migration-runner container. "
                "Either unset POSTGRES_HOST (default 'postgres' Docker "
                "service name will be used) or set it to your real "
                "Postgres hostname. See .env.example."
            )

        conn = psycopg2.connect(
            host=host,
            port=int(os.environ.get("POSTGRES_PORT", "5432")),
            user=os.environ.get("POSTGRES_USER", "playground"),
            password=os.environ.get("POSTGRES_PASSWORD", "playground"),
            dbname="postgres",
        )
        try:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT datname FROM pg_database "
                    "WHERE NOT datistemplate AND datname != 'postgres' "
                    "ORDER BY datname"
                )
                return [r[0] for r in cur.fetchall()]
        finally:
            conn.close()

    def count_rows(self, query: str) -> int:
        with self._conn.cursor() as cur:
            cur.execute(f"SELECT count(*) FROM ({query}) _mk_count")
            (n,) = cur.fetchone()
            return int(n)

    def execute_and_count(self, sql: str) -> tuple[int, float | None, float]:
        """Time `sql` server-side using `EXPLAIN (ANALYZE, FORMAT JSON,
        BUFFERS)`. Postgres reports `Execution Time` (ms) for the full
        plan execution — network-neutral, excludes EXPLAIN parse overhead.
        Row count comes from the plan's `Actual Rows`.

        Caveat: EXPLAIN ANALYZE executes any DML it wraps (INSERT /
        UPDATE / DELETE actually happen). Benchmark SQL is expected to
        be read-only — never pass write queries here."""
        import time
        import json
        explain_sql = f"EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {sql}"
        with self._conn.cursor() as cur:
            t0 = time.monotonic()
            try:
                cur.execute(explain_sql)
                explain_rows = cur.fetchall()
                wall_ms = (time.monotonic() - t0) * 1000.0
            except Exception:
                # Roll back the implicit transaction left by a failed
                # EXPLAIN — otherwise subsequent queries on this
                # connection error with "current transaction is aborted".
                try:
                    self._conn.rollback()
                except Exception:
                    pass
                raise
        plan_doc = explain_rows[0][0]
        if isinstance(plan_doc, str):
            plan_doc = json.loads(plan_doc)
        top = plan_doc[0] if isinstance(plan_doc, list) else plan_doc
        server_ms = float(top.get("Execution Time")) if top.get("Execution Time") is not None else None
        actual_rows = top.get("Plan", {}).get("Actual Rows")
        row_count = int(actual_rows) if actual_rows is not None else 0
        return row_count, server_ms, wall_ms

    def iter_batches(
        self, query: str, batch_size: int
    ) -> Iterator[list[dict[str, Any]]]:
        # Named server-side cursor streams results without loading everything.
        import psycopg2.extras as _extras  # noqa
        cur_name = f"_mk_{abs(hash(query)) & 0xFFFFFF:06x}"
        with self._conn.cursor(
            name=cur_name, cursor_factory=self._psycopg2.extras.RealDictCursor
        ) as cur:
            cur.itersize = batch_size
            cur.execute(query)
            batch: list[dict[str, Any]] = []
            for row in cur:
                batch.append(dict(row))
                if len(batch) >= batch_size:
                    yield batch
                    batch = []
            if batch:
                yield batch

    def close(self) -> None:
        try:
            self._conn.close()
        except Exception:
            pass
