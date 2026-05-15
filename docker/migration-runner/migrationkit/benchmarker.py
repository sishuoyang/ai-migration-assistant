"""
Per-query source-vs-target benchmark for step 4 of the agent workflow.

The agent dispatches:

    from migrationkit import Benchmarker, SnowflakeSource, ClickHouseTarget
    Benchmarker(
        run_id="migrate-retail-1714234560",
        source=SnowflakeSource.from_env(),
        target=ClickHouseTarget.from_env(),
        target_database="demo0514",
    ).benchmark(queries=[
        {"name": "Q1: daily revenue",
         "source_sql": "<original Snowflake SQL>",
         "target_sql": "<rewritten ClickHouse SQL from step 3>"},
        ...
    ])

Both sides are timed using each engine's own server-side execution
timer — ClickHouse `X-ClickHouse-Summary` `elapsed_ns`, Snowflake
`QUERY_HISTORY_BY_SESSION.EXECUTION_TIME`, Postgres `EXPLAIN ANALYZE`'s
`Execution Time` — so the comparison is network-neutral. Wall-clock
(`time.monotonic()` around execute+fetch) is recorded as a secondary
diagnostic column. Results land in the `benchmarks` SQLite table and
are surfaced in the dashboard's Benchmark tab.

Failures on one side (e.g. the rewritten query has a syntax error) are
captured per-row in `source_error` / `target_error` so one bad query
doesn't abort the rest of the benchmark.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from . import state

if TYPE_CHECKING:
    from .sources.base import Source
    from .targets.clickhouse import ClickHouseTarget


@dataclass(frozen=True)
class BenchmarkRow:
    query_n: int
    name: str
    source_sql: str | None
    target_sql: str | None
    # `source_ms` / `target_ms` are the **primary** metric: server-side
    # engine execution time (network-neutral). They fall back to wall_ms
    # only when the engine genuinely can't surface server timing.
    source_ms: float | None
    target_ms: float | None
    # `*_wall_ms` is the raw `time.monotonic()` bracket around
    # execute+fetch. Kept as a diagnostic — gap vs. *_ms surfaces
    # network/TLS overhead.
    source_wall_ms: float | None
    target_wall_ms: float | None
    source_rows: int | None
    target_rows: int | None
    source_error: str | None
    target_error: str | None


@dataclass(frozen=True)
class BenchmarkResult:
    rows: list[BenchmarkRow]


class Benchmarker:
    """Per-query wall-clock comparison between a source and a
    ClickHouse Cloud target. One Benchmarker per agent-triggered
    step-4 invocation; re-running overwrites prior rows."""

    def __init__(
        self,
        run_id: str,
        source: "Source",
        target: "ClickHouseTarget",
        *,
        target_database: str | None = None,
    ) -> None:
        self.run_id = run_id
        self.source = source
        self.target = target
        self.target_database = target_database or target.database
        # Propagate to the target so benchmark SQL that names tables
        # unqualified (e.g. `SELECT … FROM lineitem`) resolves against
        # the run's database rather than CLICKHOUSE_CLOUD_DATABASE from
        # env. Mirrors the same fix in Migrator + Validator.
        self.target.use_database(self.target_database)

    def benchmark(self, queries: list[dict]) -> BenchmarkResult:
        """For each query dict {name, source_sql?, target_sql?}, run
        on each side, capture server-side execution time (primary) +
        wall-clock (diagnostic), record. Either SQL can be omitted;
        the corresponding side just doesn't get timed (useful for
        validating that a rewritten query parses on the target without
        a paired source query).

        Calls `delete_benchmarks_for_run` first so re-runs start clean.

        Emits:
          - `benchmark_row` per query (live updates for the dashboard)
          - `benchmark_done` once (final summary)
          - `step_benchmarked` once (lights up the step-4 checkmark;
            replaces the curl from the old prompt)
        """
        self._log(f"▶ Benchmarking {len(queries)} query/queries …")
        state.delete_benchmarks_for_run(self.run_id)

        rows: list[BenchmarkRow] = []
        speedups: list[float] = []   # only when both sides timed cleanly

        for n, q in enumerate(queries):
            name = q.get("name") or f"Q{n + 1}"
            source_sql = q.get("source_sql")
            target_sql = q.get("target_sql")

            source_ms, source_wall_ms, source_rows, source_error = self._run_side(
                self.source, source_sql
            )
            target_ms, target_wall_ms, target_rows, target_error = self._run_side(
                self.target, target_sql
            )

            row = BenchmarkRow(
                query_n=n,
                name=name,
                source_sql=source_sql,
                target_sql=target_sql,
                source_ms=source_ms,
                target_ms=target_ms,
                source_wall_ms=source_wall_ms,
                target_wall_ms=target_wall_ms,
                source_rows=source_rows,
                target_rows=target_rows,
                source_error=source_error,
                target_error=target_error,
            )
            rows.append(row)

            state.record_benchmark_row(
                run_id=self.run_id,
                query_n=row.query_n,
                name=row.name,
                source_sql=row.source_sql,
                target_sql=row.target_sql,
                source_ms=row.source_ms,
                target_ms=row.target_ms,
                source_wall_ms=row.source_wall_ms,
                target_wall_ms=row.target_wall_ms,
                source_rows=row.source_rows,
                target_rows=row.target_rows,
                source_error=row.source_error,
                target_error=row.target_error,
            )
            state.write_event(self.run_id, "benchmark_row", {
                "query_n": row.query_n,
                "name": row.name,
                "source_ms": row.source_ms,
                "target_ms": row.target_ms,
                "source_wall_ms": row.source_wall_ms,
                "target_wall_ms": row.target_wall_ms,
                "source_rows": row.source_rows,
                "target_rows": row.target_rows,
                "source_error": row.source_error,
                "target_error": row.target_error,
            })
            self._log_row(row)

            if (source_ms is not None and target_ms is not None
                    and target_ms > 0):
                speedups.append(source_ms / target_ms)

        avg_speedup = (
            sum(speedups) / len(speedups) if speedups else None
        )
        summary = {
            "count": len(rows),
            "completed": sum(
                1 for r in rows
                if r.source_error is None and r.target_error is None
            ),
            "avg_speedup": avg_speedup,
        }
        state.write_event(self.run_id, "benchmark_done", summary)
        state.write_event(self.run_id, "step_benchmarked", summary)

        if avg_speedup is not None:
            self._log(f"✓ Average speedup: {avg_speedup:.1f}×")
        else:
            self._log(
                "✓ Benchmark complete (no comparable rows — "
                "check source_error / target_error in the dashboard)."
            )

        return BenchmarkResult(rows=rows)

    # ── internals ────────────────────────────────────────────────────

    def _run_side(
        self,
        runner: object,
        sql: str | None,
    ) -> tuple[float | None, float | None, int | None, str | None]:
        """Run `sql` on `runner` (a Source or ClickHouseTarget — both
        expose `execute_and_count(sql) -> (rows, server_ms, wall_ms)`).
        Returns `(primary_ms, wall_ms, row_count, error)` where
        `primary_ms` is the engine's server-side timing — falling back
        to wall_ms if the engine couldn't surface it — so the primary
        column always has a value when the query succeeded.
        If sql is None, returns all None — caller treats that side as
        un-timed."""
        if not sql:
            return None, None, None, None
        try:
            rows, server_ms, wall_ms = runner.execute_and_count(sql)  # type: ignore[attr-defined]
            primary_ms = float(server_ms) if server_ms is not None else float(wall_ms)
            return primary_ms, float(wall_ms), int(rows), None
        except Exception as e:
            return None, None, None, str(e)

    def _log(self, msg: str) -> None:
        print(msg, flush=True)
        state.write_event(self.run_id, "log", {"message": msg})

    def _log_row(self, row: BenchmarkRow) -> None:
        # One concise line per query so `tail_python_job` surfaces
        # something useful even before the dashboard catches up. Primary
        # ms is engine-side; we only append `(wall: Xms)` when the gap
        # is large enough to be meaningful — otherwise the line is noise.
        def _fmt(primary, wall, rows, error):
            if error:
                return f"ERR ({error})"
            if primary is None:
                return "—"
            wall_suffix = ""
            if wall is not None and (wall - primary) >= 200.0:
                wall_suffix = f" (wall: {wall:.0f}ms)"
            return f"{primary:.0f}ms{wall_suffix} / {rows} rows"

        src_part = _fmt(row.source_ms, row.source_wall_ms, row.source_rows, row.source_error)
        tgt_part = _fmt(row.target_ms, row.target_wall_ms, row.target_rows, row.target_error)
        speedup = (
            f"  speedup={row.source_ms / row.target_ms:.1f}×"
            if (row.source_ms and row.target_ms and row.target_ms > 0)
            else ""
        )
        self._log(f"  {row.name}: source={src_part}  target={tgt_part}{speedup}")
