"""
SQLite state store shared between the user-script process (which writes
via the `Migrator` library) and the migration-runner MCP process (which
reads via the FastAPI HTTP layer).

WAL mode + short transactions handles the multi-writer scenario at the
event rates this project sees (a few writes/sec peak).
"""
from __future__ import annotations

import json
import os
import sqlite3
import threading
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterator

DB_PATH = Path(os.environ.get("MIGRATIONKIT_DB", "/workspace/state/migrationkit.db"))

_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
  run_id          TEXT PRIMARY KEY,
  source_type     TEXT NOT NULL,
  source_database TEXT,
  target_database TEXT,
  status          TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  error           TEXT
);

CREATE TABLE IF NOT EXISTS run_tables (
  run_id     TEXT NOT NULL,
  table_name TEXT NOT NULL,
  total_rows INTEGER,
  rows_done  INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL,
  strategy   TEXT NOT NULL DEFAULT 'direct',
  -- s3_stage sub-state: 'unloading' | 'staged' | 'loading' | 'validating'.
  -- NULL for strategy='direct' (no phases for the batch path).
  phase      TEXT,
  PRIMARY KEY (run_id, table_name),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS batches (
  run_id        TEXT NOT NULL,
  table_name    TEXT NOT NULL,
  batch_n       INTEGER NOT NULL,
  rows          INTEGER NOT NULL,
  source_offset INTEGER,
  bytes_in      INTEGER,
  bytes_out     INTEGER,
  seconds       REAL,
  finished_at   TEXT NOT NULL,
  PRIMARY KEY (run_id, table_name, batch_n),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id       TEXT NOT NULL,
  ts           TEXT NOT NULL,
  kind         TEXT NOT NULL,
  payload_json TEXT
);

CREATE INDEX IF NOT EXISTS events_by_run ON events(run_id, id);

CREATE TABLE IF NOT EXISTS controls (
  run_id TEXT PRIMARY KEY,
  flag   TEXT NOT NULL DEFAULT 'run',
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

-- Per-table row-count comparison results written by `Validator.validate()`.
-- One row per (run_id, table_name). `matched=0` when source_rows !=
-- target_rows OR when `error` is non-null (one side raised). The
-- dashboard's Validation tab reads `GET /api/runs/{id}/validations`.
CREATE TABLE IF NOT EXISTS validations (
  run_id      TEXT NOT NULL,
  table_name  TEXT NOT NULL,
  source_rows INTEGER,
  target_rows INTEGER,
  matched     INTEGER NOT NULL,
  error       TEXT,
  checked_at  TEXT NOT NULL,
  PRIMARY KEY (run_id, table_name),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);

-- Per-query timing comparison written by `Benchmarker.benchmark()`.
-- `query_n` is the position in the agent's input list (0-indexed).
-- Either side's ms/rows is NULL when that side raised; the error
-- column captures the reason. The dashboard's Benchmark tab reads
-- `GET /api/runs/{id}/benchmarks`.
-- `source_ms` / `target_ms` are server-side engine execution time
-- (network-neutral); `source_wall_ms` / `target_wall_ms` are the
-- corresponding `time.monotonic()` brackets retained as a diagnostic
-- so the gap surfaces network/TLS overhead. See migrationkit.benchmarker.
CREATE TABLE IF NOT EXISTS benchmarks (
  run_id         TEXT NOT NULL,
  query_n        INTEGER NOT NULL,
  name           TEXT NOT NULL,
  source_sql     TEXT,
  target_sql     TEXT,
  source_ms      REAL,
  target_ms      REAL,
  source_wall_ms REAL,
  target_wall_ms REAL,
  source_rows    INTEGER,
  target_rows    INTEGER,
  source_error   TEXT,
  target_error   TEXT,
  ran_at         TEXT NOT NULL,
  PRIMARY KEY (run_id, query_n),
  FOREIGN KEY (run_id) REFERENCES runs(run_id) ON DELETE CASCADE
);
"""

_init_lock = threading.Lock()
_initialized = False


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _ensure_initialized() -> None:
    global _initialized
    if _initialized:
        return
    with _init_lock:
        if _initialized:
            return
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(DB_PATH, isolation_level=None)
        try:
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA foreign_keys=ON")
            conn.executescript(_SCHEMA)
            _migrate_phase_column(conn)
            _migrate_benchmarks_wall_columns(conn)
        finally:
            conn.close()
        _initialized = True


def _migrate_phase_column(conn: sqlite3.Connection) -> None:
    """Idempotent: SQLite has no `ALTER TABLE ADD COLUMN IF NOT EXISTS`,
    so we read PRAGMA table_info and add the column only if it's missing.
    Existing pre-Phase-6 databases pick up the new `phase` column on
    first import after upgrade. Direct-path tables leave it NULL."""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(run_tables)")}
    if "phase" not in cols:
        conn.execute("ALTER TABLE run_tables ADD COLUMN phase TEXT")


def _migrate_benchmarks_wall_columns(conn: sqlite3.Connection) -> None:
    """Add `source_wall_ms` / `target_wall_ms` to pre-existing
    `benchmarks` rows so the dashboard's new wall-time subline keeps
    working after upgrade. Pre-migration rows have wall=NULL — the
    UI hides the subline in that case."""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(benchmarks)")}
    if "source_wall_ms" not in cols:
        conn.execute("ALTER TABLE benchmarks ADD COLUMN source_wall_ms REAL")
    if "target_wall_ms" not in cols:
        conn.execute("ALTER TABLE benchmarks ADD COLUMN target_wall_ms REAL")


@contextmanager
def get_conn() -> Iterator[sqlite3.Connection]:
    """Short-lived connection per operation; cheap with WAL mode."""
    _ensure_initialized()
    conn = sqlite3.connect(DB_PATH, timeout=10.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


# ─── writes (called by Migrator library) ──────────────────────────────


class ActiveRunError(RuntimeError):
    """Raised when a second Migrator() is attempted while another run is active."""


def create_run(
    run_id: str,
    source_type: str,
    source_database: str | None,
    target_database: str | None,
) -> None:
    with get_conn() as conn:
        active = conn.execute(
            "SELECT run_id FROM runs WHERE status IN ('running','paused')"
        ).fetchone()
        if active is not None and active["run_id"] != run_id:
            raise ActiveRunError(
                f"Another migration is already active: {active['run_id']!r}. "
                "Cancel or finish it before starting a new one."
            )
        conn.execute(
            "INSERT OR REPLACE INTO runs(run_id, source_type, source_database, "
            "target_database, status, started_at) VALUES(?,?,?,?,?,?)",
            (run_id, source_type, source_database, target_database, "running", _now()),
        )
        conn.execute(
            "INSERT OR REPLACE INTO controls(run_id, flag) VALUES(?, 'run')",
            (run_id,),
        )
    write_event(run_id, "started", {
        "source_type": source_type,
        "source_database": source_database,
        "target_database": target_database,
    })


def finish_run(run_id: str, status: str, error: str | None = None) -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE runs SET status=?, ended_at=?, error=? WHERE run_id=?",
            (status, _now(), error, run_id),
        )
    write_event(run_id, status, {"error": error} if error else {})


def set_run_status(run_id: str, status: str) -> None:
    """In-flight status change without setting ended_at — used when the
    Migrator transitions running↔paused. Use finish_run() for terminal
    transitions (done/failed/cancelled)."""
    with get_conn() as conn:
        conn.execute(
            "UPDATE runs SET status=? WHERE run_id=? AND ended_at IS NULL",
            (status, run_id),
        )


def register_table(
    run_id: str, table_name: str, total_rows: int | None, strategy: str = "direct"
) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO run_tables(run_id, table_name, total_rows, "
            "rows_done, status, strategy) VALUES(?,?,?,?,?,?)",
            (run_id, table_name, total_rows, 0, "pending", strategy),
        )


def set_table_status(run_id: str, table_name: str, status: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE run_tables SET status=? WHERE run_id=? AND table_name=?",
            (status, run_id, table_name),
        )


def set_table_phase(run_id: str, table_name: str, phase: str | None) -> None:
    """Set the S3-staging sub-phase. NULL clears it back to "no phase"
    (used after validation completes). Always paired with a
    `phase_started` event emitted by the Migrator."""
    with get_conn() as conn:
        conn.execute(
            "UPDATE run_tables SET phase=? WHERE run_id=? AND table_name=?",
            (phase, run_id, table_name),
        )


def set_table_rows_done(run_id: str, table_name: str, rows_done: int) -> None:
    """SET (not increment) rows_done. Used by the S3-stage path which
    produces one final row count after `INSERT FROM s3()` completes,
    rather than incrementally accumulating per-batch."""
    with get_conn() as conn:
        conn.execute(
            "UPDATE run_tables SET rows_done=? WHERE run_id=? AND table_name=?",
            (rows_done, run_id, table_name),
        )


def set_table_total_rows(run_id: str, table_name: str, total_rows: int) -> None:
    """Update `total_rows` after registration. Used by S3 staging when
    the row count is only known after the unload completes (Snowflake's
    COPY INTO returns row counts in its result; alternatively the
    migrator counts rows up front like the direct path does)."""
    with get_conn() as conn:
        conn.execute(
            "UPDATE run_tables SET total_rows=? WHERE run_id=? AND table_name=?",
            (total_rows, run_id, table_name),
        )


def record_batch(
    run_id: str,
    table_name: str,
    batch_n: int,
    rows: int,
    source_offset: int | None,
    bytes_in: int | None,
    bytes_out: int | None,
    seconds: float,
) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO batches(run_id, table_name, batch_n, rows, "
            "source_offset, bytes_in, bytes_out, seconds, finished_at) "
            "VALUES(?,?,?,?,?,?,?,?,?)",
            (run_id, table_name, batch_n, rows, source_offset,
             bytes_in, bytes_out, seconds, _now()),
        )
        conn.execute(
            "UPDATE run_tables SET rows_done = rows_done + ? "
            "WHERE run_id=? AND table_name=?",
            (rows, run_id, table_name),
        )
    write_event(run_id, "batch_done", {
        "table": table_name, "batch_n": batch_n, "rows": rows, "seconds": seconds,
    })


def record_staged_load(
    run_id: str,
    table_name: str,
    rows: int,
    bytes_in: int,
    bytes_out: int,
    seconds: float,
) -> None:
    """Record a successful staged (S3 or GCS) load as a single batch
    row. Engine-agnostic — the strategy is recorded on the event side.

    Unlike `record_batch`, this does NOT emit a `batch_done` event
    (staged tables surface progress through `phase_started` and
    `bytes_progress` events instead). It writes one row to `batches`
    with `batch_n=0` and SETS `run_tables.rows_done = rows` (not
    increment) so callers can use this as the canonical post-load
    count regardless of any in-flight `bytes_progress` samples."""
    with get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO batches(run_id, table_name, batch_n, rows, "
            "source_offset, bytes_in, bytes_out, seconds, finished_at) "
            "VALUES(?,?,0,?,NULL,?,?,?,?)",
            (run_id, table_name, rows, bytes_in, bytes_out, seconds, _now()),
        )
        conn.execute(
            "UPDATE run_tables SET rows_done=? WHERE run_id=? AND table_name=?",
            (rows, run_id, table_name),
        )


def write_event(run_id: str, kind: str, payload: dict[str, Any] | None = None) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO events(run_id, ts, kind, payload_json) VALUES(?,?,?,?)",
            (run_id, _now(), kind, json.dumps(payload or {})),
        )
        return cur.lastrowid


# ─── controls (read by library, written by FastAPI) ───────────────────


def get_control_flag(run_id: str) -> str:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT flag FROM controls WHERE run_id=?", (run_id,)
        ).fetchone()
        return row["flag"] if row else "run"


def set_control_flag(run_id: str, flag: str) -> None:
    if flag not in ("run", "pause", "cancel"):
        raise ValueError(f"invalid flag {flag!r}")
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO controls(run_id, flag) VALUES(?,?) "
            "ON CONFLICT(run_id) DO UPDATE SET flag=excluded.flag",
            (run_id, flag),
        )


# ─── reads (called by FastAPI) ────────────────────────────────────────


def list_runs() -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM runs ORDER BY started_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]


def get_run(run_id: str) -> dict | None:
    with get_conn() as conn:
        run = conn.execute(
            "SELECT * FROM runs WHERE run_id=?", (run_id,)
        ).fetchone()
        if not run:
            return None
        tables = conn.execute(
            "SELECT * FROM run_tables WHERE run_id=? ORDER BY table_name", (run_id,)
        ).fetchall()
        flag = conn.execute(
            "SELECT flag FROM controls WHERE run_id=?", (run_id,)
        ).fetchone()
        return {
            **dict(run),
            "tables": [dict(t) for t in tables],
            "control_flag": flag["flag"] if flag else "run",
        }


def events_since(run_id: str, since_id: int) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM events WHERE run_id=? AND id > ? ORDER BY id LIMIT 200",
            (run_id, since_id),
        ).fetchall()
        return [
            {
                **dict(r),
                "payload": json.loads(r["payload_json"]) if r["payload_json"] else {},
            }
            for r in rows
        ]


# ─── validations + benchmarks (written by Validator/Benchmarker, ──────
# ─── read by FastAPI) ─────────────────────────────────────────────────


def record_validation_row(
    run_id: str,
    table_name: str,
    source_rows: int | None,
    target_rows: int | None,
    matched: bool,
    error: str | None = None,
) -> None:
    """Persist one row of the Validator's row-count comparison.
    INSERT OR REPLACE — re-running validation overwrites the prior
    row for the same (run_id, table_name)."""
    with get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO validations("
            "run_id, table_name, source_rows, target_rows, matched, "
            "error, checked_at) VALUES(?,?,?,?,?,?,?)",
            (run_id, table_name, source_rows, target_rows,
             1 if matched else 0, error, _now()),
        )


def list_validations(run_id: str) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM validations WHERE run_id=? ORDER BY table_name",
            (run_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def delete_validations_for_run(run_id: str) -> None:
    """Clear all validation rows for a run. Validator.validate() calls
    this at the top of each invocation so re-runs start clean — without
    this, dropping a table from the migration mid-iteration would leave
    a stale row visible in the dashboard."""
    with get_conn() as conn:
        conn.execute("DELETE FROM validations WHERE run_id=?", (run_id,))


def record_benchmark_row(
    run_id: str,
    query_n: int,
    name: str,
    source_sql: str | None,
    target_sql: str | None,
    source_ms: float | None,
    target_ms: float | None,
    source_rows: int | None,
    target_rows: int | None,
    source_error: str | None = None,
    target_error: str | None = None,
    source_wall_ms: float | None = None,
    target_wall_ms: float | None = None,
) -> None:
    """Persist one query's source-vs-target timing + row counts.
    `source_ms` / `target_ms` are server-side engine time (primary);
    `*_wall_ms` is the secondary `time.monotonic()` bracket.
    INSERT OR REPLACE — re-running benchmark overwrites prior rows."""
    with get_conn() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO benchmarks("
            "run_id, query_n, name, source_sql, target_sql, "
            "source_ms, target_ms, source_wall_ms, target_wall_ms, "
            "source_rows, target_rows, "
            "source_error, target_error, ran_at) "
            "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (run_id, query_n, name, source_sql, target_sql,
             source_ms, target_ms, source_wall_ms, target_wall_ms,
             source_rows, target_rows,
             source_error, target_error, _now()),
        )


def list_benchmarks(run_id: str) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM benchmarks WHERE run_id=? ORDER BY query_n",
            (run_id,),
        ).fetchall()
        return [dict(r) for r in rows]


def delete_benchmarks_for_run(run_id: str) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM benchmarks WHERE run_id=?", (run_id,))


def delete_run(run_id: str) -> bool:
    with get_conn() as conn:
        run = conn.execute(
            "SELECT status FROM runs WHERE run_id=?", (run_id,)
        ).fetchone()
        if not run:
            return False
        if run["status"] in ("running", "paused"):
            raise ValueError(f"cannot delete an active run ({run['status']})")
        conn.execute("DELETE FROM runs WHERE run_id=?", (run_id,))
        return True
