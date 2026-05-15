"""
Row-count validation for a just-finished migration.

The agent dispatches a tiny script in step 3:

    from migrationkit import Validator, SnowflakeSource, ClickHouseTarget
    Validator(
        run_id="migrate-retail-1714234560",
        source=SnowflakeSource.from_env(),
        target=ClickHouseTarget.from_env(),
        target_database="demo0514",
    ).validate()

The Validator auto-discovers which tables to check from the run's
`run_tables` rows (so the agent doesn't have to repeat the list from
step 2), counts both sides, persists per-table results into the
`validations` table, and emits events the dashboard renders in its
Validation tab.

The old step-3 prompt asked the agent to author ~30 lines of script for
the same thing — this collapses that to one constructor + one method
call, freeing LLM tokens and recursion budget.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import TYPE_CHECKING

from . import state

if TYPE_CHECKING:
    from .sources.base import Source
    from .targets.clickhouse import ClickHouseTarget


@dataclass(frozen=True)
class ValidationRow:
    table_name: str
    source_rows: int | None
    target_rows: int | None
    matched: bool
    error: str | None


@dataclass(frozen=True)
class ValidationResult:
    rows: list[ValidationRow]
    all_matched: bool


class Validator:
    """Per-table row-count comparison between a source and a ClickHouse
    Cloud target. One Validator per agent-triggered step-3 invocation;
    re-running overwrites the previous rows for that run_id."""

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
        # Source of truth for which database the target rows live in.
        # Same precedence as Migrator: explicit override, else whatever
        # ClickHouseTarget was constructed with.
        self.target_database = target_database or target.database
        # Propagate to the target so `target.count_rows(table)` qualifies
        # with the run's database, not whatever CLICKHOUSE_CLOUD_DATABASE
        # the target was constructed with. Without this, validation can
        # silently report counts from the env-default database.
        self.target.use_database(self.target_database)

    def validate(
        self,
        tables: list[str] | None = None,
        *,
        raise_on_mismatch: bool = False,
    ) -> ValidationResult:
        """Run row-count comparison for `tables` (or auto-discover from
        the run's `run_tables` when None). Catches per-table errors so
        one bad table doesn't abort the rest of the check.

        Calls `state.delete_validations_for_run(run_id)` first so a
        re-run starts clean — partner re-running step 3 after fixing
        a target table sees only the new results, not a mix.

        Emits:
          - `validation_row` per table (live updates for the dashboard)
          - `validation_done` once (final summary)
          - `step_validated` once (lights up the step-3 checkmark)

        Returns a `ValidationResult`; if `raise_on_mismatch=True` and
        any row mismatches/errors, raises RuntimeError after recording
        everything (so the agent sees the failure AND the dashboard
        still has the partial results)."""
        if tables is None:
            tables = self._discover_tables()

        self._log(
            f"▶ Validating {len(tables)} table(s) "
            f"in target `{self.target_database}` …"
        )
        state.delete_validations_for_run(self.run_id)

        rows: list[ValidationRow] = []
        n_matched = 0
        n_mismatched = 0
        n_errored = 0

        for tbl in tables:
            row = self._check_table(tbl)
            rows.append(row)
            if row.error is not None:
                n_errored += 1
            elif row.matched:
                n_matched += 1
            else:
                n_mismatched += 1
            state.record_validation_row(
                self.run_id,
                row.table_name,
                row.source_rows,
                row.target_rows,
                row.matched,
                error=row.error,
            )
            state.write_event(self.run_id, "validation_row", {
                "table": row.table_name,
                "source_rows": row.source_rows,
                "target_rows": row.target_rows,
                "matched": row.matched,
                "error": row.error,
            })
            self._log_row(row)

        all_matched = n_mismatched == 0 and n_errored == 0
        summary = {
            "matched": n_matched,
            "mismatched": n_mismatched,
            "errored": n_errored,
            "total": len(rows),
        }
        state.write_event(self.run_id, "validation_done", summary)
        # Step_validated is what the dashboard's existing milestone
        # mapper keys off — emitting it here means the agent doesn't
        # need a separate curl to /api/runs/{id}/mark/validated.
        state.write_event(self.run_id, "step_validated", summary)

        if all_matched:
            self._log(f"✓ All {len(rows)} table(s) matched.")
        else:
            self._log(
                f"✗ {n_mismatched} mismatched, {n_errored} errored, "
                f"{n_matched} ok."
            )

        result = ValidationResult(rows=rows, all_matched=all_matched)
        if raise_on_mismatch and not all_matched:
            raise RuntimeError(
                f"Validation failed for run {self.run_id!r}: "
                f"{n_mismatched} mismatched + {n_errored} errored."
            )
        return result

    # ── internals ────────────────────────────────────────────────────

    def _discover_tables(self) -> list[str]:
        """Pull table names from `run_tables`. Skip anything that didn't
        reach `status='done'` — pending/failed tables don't have a
        meaningful target row count yet."""
        run = state.get_run(self.run_id) or {}
        out: list[str] = []
        for t in run.get("tables", []):
            if t.get("status") == "done":
                out.append(t["table_name"])
        return out

    def _check_table(self, table_name: str) -> ValidationRow:
        source_rows: int | None = None
        target_rows: int | None = None
        error: str | None = None
        try:
            # `SELECT * FROM <table>` works on every Source (count_rows
            # wraps it in `SELECT count(*) FROM (…)`).
            source_rows = self.source.count_rows(f"SELECT * FROM {table_name}")
        except Exception as e:
            error = f"source: {e}"
        try:
            target_rows = self.target.count_rows(table_name)
        except Exception as e:
            error = (error + " | " if error else "") + f"target: {e}"

        matched = (
            error is None
            and source_rows is not None
            and target_rows is not None
            and source_rows == target_rows
        )
        return ValidationRow(
            table_name=table_name,
            source_rows=source_rows,
            target_rows=target_rows,
            matched=matched,
            error=error,
        )

    def _log(self, msg: str) -> None:
        print(msg, flush=True)
        state.write_event(self.run_id, "log", {"message": msg})

    def _log_row(self, row: ValidationRow) -> None:
        if row.error:
            self._log(f"  ✗ {row.table_name}: {row.error}")
        else:
            mark = "✓" if row.matched else "✗"
            self._log(
                f"  {mark} {row.table_name}: "
                f"source={row.source_rows:,} target={row.target_rows:,}"
            )
