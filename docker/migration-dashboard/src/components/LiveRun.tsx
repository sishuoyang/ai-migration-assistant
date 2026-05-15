/**
 * Left-rail "live run" panel. Owns the run picker, run controls, status
 * banners, and a 3-tab content area: Migration / Validation / Benchmark.
 *
 * The KPI tiles + tables list + milestones (what used to be this file's
 * whole bottom half) now live in MigrationView; the validation and
 * benchmark tabs render the typed result tables produced by the
 * Python-side Validator/Benchmarker in steps 3 and 4.
 */
import { Icon, ICONS } from "./Icon";
import { CollapseToggle } from "./CollapseToggle";
import { RunPicker } from "./RunPicker";
import { LiveRunTabs, type LiveRunTabKey } from "./LiveRunTabs";
import { MigrationView } from "./MigrationView";
import { ValidationView } from "./ValidationView";
import { BenchmarkView } from "./BenchmarkView";
import { useLiveRun } from "../hooks/useLiveRun";
import { useValidations } from "../hooks/useValidations";
import { useBenchmarks } from "../hooks/useBenchmarks";
import { fmtSec, fmtRowsShort, fmtRows, fmtPct } from "../lib/fmt";
import { api, type Run } from "../lib/api";
import { useEffect, useState } from "react";

interface Props {
  runs: Run[];
  selectedRunId: string | null;
  onSelectRun: (id: string) => void;
  /** Click the rocket button on the idle hero to start a fresh chat-driven
   *  migration. The dashboard doesn't kick off scripts itself — this
   *  scrolls the chat into focus (or fires step 2's prompt; wired in App). */
  onStartDemo?: () => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function LiveRun({
  runs,
  selectedRunId,
  onSelectRun,
  onStartDemo,
  collapsed,
  onToggleCollapsed,
}: Props) {
  const live = useLiveRun(selectedRunId);
  const { status, run, kpis, totals } = live;

  // Each result tab opens its own SSE connection — small lists, simple
  // refetch-on-event; cheaper to wire than a shared subscription.
  const validations = useValidations(selectedRunId);
  const benchmarks = useBenchmarks(selectedRunId);

  // Tab state is local. Reset to Migration when the selected run
  // changes so partners don't land on an empty Validation tab after
  // switching to a fresh run.
  const [tab, setTab] = useState<LiveRunTabKey>("migration");
  useEffect(() => {
    setTab("migration");
  }, [selectedRunId]);

  // The "current" run is the newest one in the list.
  const isCurrent = !!selectedRunId && runs[0]?.run_id === selectedRunId;

  const [controlBusy, setControlBusy] = useState<null | "pause" | "resume" | "cancel" | "delete">(
    null,
  );

  async function fireControl(action: "pause" | "resume" | "cancel") {
    if (!selectedRunId) return;
    setControlBusy(action);
    try {
      if (action === "pause") await api.pauseRun(selectedRunId);
      else if (action === "resume") await api.resumeRun(selectedRunId);
      else await api.cancelRun(selectedRunId);
    } finally {
      setControlBusy(null);
    }
  }

  // Idle view (no runs yet, or no run selected).
  if (status === "idle" || !run) {
    return (
      <div className={`hero ${collapsed ? "is-collapsed" : ""}`}>
        <div className="hero-collapsed-strip">
          <span className="chrome-status-pill" data-tone="idle">
            <span className="dot" /> Idle
          </span>
          <span className="runid">No active run · ready to start</span>
          <CollapseToggle collapsed={collapsed} onClick={onToggleCollapsed} />
        </div>

        <div className="hero-head">
          <div className="hero-head-left">
            <span className="hero-eyebrow">KPI dashboard · no active run</span>
            <RunPicker
              runs={runs}
              selectedId={selectedRunId}
              onSelect={onSelectRun}
              selectedStatus="idle"
            />
          </div>
          <div className="hero-controls">
            <CollapseToggle collapsed={collapsed} onClick={onToggleCollapsed} />
          </div>
        </div>
        <div className="idle-hero">
          <div className="title">
            Ready to migrate.
            <br />
            <b>Pick a source, fire step 1.</b>
          </div>
          <div className="sub">
            Once a migration is running, this panel turns into the live
            dashboard — rows per second, ETA, table-by-table progress, and
            the milestone log. Use the dropdown above to inspect any past
            run.
          </div>
          {onStartDemo && (
            <button className="btn btn-primary" onClick={onStartDemo}>
              <Icon d={ICONS.rocket} /> Start demo migration
            </button>
          )}
        </div>
      </div>
    );
  }

  const runId = run.run_id;
  const elapsedLabel =
    kpis.elapsedSec >= 60
      ? `${Math.floor(kpis.elapsedSec / 60)}m ${kpis.elapsedSec % 60}s ago`
      : `${kpis.elapsedSec}s ago`;
  const startedAtLabel = new Date(run.started_at).toLocaleTimeString();

  const runLabel = isCurrent
    ? "KPI dashboard · live · step 2 — migrate data"
    : `KPI dashboard · viewing past run · ${startedAtLabel}`;

  return (
    <div className={`hero ${collapsed ? "is-collapsed" : ""}`}>
      {/* Collapsed strip */}
      <div className="hero-collapsed-strip">
        <span className="chrome-status-pill" data-tone={status}>
          <span className="dot" />
          {status === "running" ? "Migrating" : status}
        </span>
        <span className="runid">{runId}</span>
        <span className="mini-kpi">
          <span className="label">r/s</span>
          {status === "running" ? fmtRowsShort(kpis.inst).replace(/\.0$/, "") : "—"}
        </span>
        <span className="mini-kpi">
          <span className="label">ETA</span>
          {status === "running"
            ? fmtSec(kpis.etaSec)
            : status === "paused"
              ? "paused"
              : status === "done"
                ? "done"
                : "—"}
        </span>
        <div className="mini-bar">
          <div data-tone={status === "running" ? "" : status} style={{ width: `${kpis.pct}%` }} />
        </div>
        <span className="mini-kpi">{fmtPct(kpis.pct)}</span>
        <CollapseToggle collapsed={collapsed} onClick={onToggleCollapsed} />
      </div>

      {/* Header */}
      <div className="hero-head">
        <div className="hero-head-left">
          <div className="hero-eyebrow">{runLabel}</div>
          <RunPicker
            runs={runs}
            selectedId={selectedRunId}
            onSelect={onSelectRun}
            selectedStatus={status}
          />
          <div className="hero-sub" style={{ marginTop: 6 }}>
            <span>{run.source_type}</span>
            <span style={{ color: "#3D3D3D" }}>·</span>
            <span>{run.source_database ?? "?"}</span>
            <span className="arrow">→</span>
            <span>{run.target_database ?? "ClickHouse Cloud"}</span>
            <span style={{ color: "#3D3D3D" }}>·</span>
            <span>{isCurrent ? `started ${elapsedLabel}` : `started ${startedAtLabel}`}</span>
          </div>
        </div>
        <div className="hero-controls">
          {isCurrent && status === "running" && (
            <>
              <button
                className="btn"
                disabled={controlBusy !== null}
                onClick={() => fireControl("pause")}
              >
                <Icon d={ICONS.pause} /> {controlBusy === "pause" ? "Pausing…" : "Pause"}
              </button>
              <button
                className="btn btn-danger"
                disabled={controlBusy !== null}
                onClick={() => fireControl("cancel")}
              >
                <Icon d={ICONS.stop} /> Cancel
              </button>
            </>
          )}
          {isCurrent && status === "paused" && (
            <>
              <button
                className="btn btn-primary"
                disabled={controlBusy !== null}
                onClick={() => fireControl("resume")}
              >
                <Icon d={ICONS.play} /> {controlBusy === "resume" ? "Resuming…" : "Resume"}
              </button>
              <button
                className="btn btn-danger"
                disabled={controlBusy !== null}
                onClick={() => fireControl("cancel")}
              >
                <Icon d={ICONS.stop} /> Cancel
              </button>
            </>
          )}
          {(status === "done" || status === "failed") && onStartDemo && (
            <button className="btn" onClick={onStartDemo}>
              <Icon d={ICONS.redo} /> Re-run
            </button>
          )}
          <CollapseToggle collapsed={collapsed} onClick={onToggleCollapsed} />
        </div>
      </div>

      {/* Banners for non-running states */}
      {status === "paused" && (
        <div className="run-banner" data-tone="paused">
          <span className="b-mark">‖</span>
          <span>
            Paused at batch boundary. The library will resume from the next
            batch — no data lost.
          </span>
        </div>
      )}
      {status === "failed" && run.error && (
        <div className="run-banner" data-tone="failed">
          <span className="b-mark">!</span>
          <span>
            Run failed:{" "}
            <code style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
              {run.error}
            </code>
          </span>
        </div>
      )}
      {status === "done" && (
        <div className="run-banner" data-tone="done">
          <span className="b-mark">✓</span>
          <span>
            <b>{fmtRows(totals.done)} rows</b> migrated in{" "}
            {fmtSec(kpis.elapsedSec)} · avg {fmtRowsShort(kpis.cum)} rows/sec.
            Step 3 (validate &amp; rewrite) is unlocked.
          </span>
        </div>
      )}

      {/* Tab bar — three views over the same run_id. */}
      <LiveRunTabs
        tab={tab}
        onChange={setTab}
        counts={{
          validation: validations.rows.length,
          benchmark: benchmarks.rows.length,
        }}
      />

      {tab === "migration" && (
        <MigrationView live={live} startedAtLabel={startedAtLabel} />
      )}
      {tab === "validation" && (
        <ValidationView
          rows={validations.rows}
          loading={validations.loading}
          error={validations.error}
        />
      )}
      {tab === "benchmark" && (
        <BenchmarkView
          rows={benchmarks.rows}
          loading={benchmarks.loading}
          error={benchmarks.error}
        />
      )}
    </div>
  );
}
