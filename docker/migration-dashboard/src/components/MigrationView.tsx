/**
 * Migration tab content — KPI strip + overall progress + tables list
 * + milestones.
 *
 * Extracted from the bottom half of LiveRun.tsx unchanged. LiveRun
 * still owns the header (run picker, controls, banners) — this is
 * purely the "what's the migration doing" panel that lives below the
 * tab bar when the Migration tab is active.
 */
import type { LiveRunState, DisplayStatus } from "../hooks/useLiveRun";
import type { TablePhase, TableStatus } from "../lib/api";
import { Sparkline } from "./Sparkline";
import { fmtSec, fmtRowsShort, fmtRows, fmtPct } from "../lib/fmt";

interface Props {
  live: LiveRunState;
  startedAtLabel: string;
}

const SPARK_COLORS: Record<DisplayStatus, string> = {
  running: "#FAFF69",
  paused: "#FFB020",
  failed: "#E5484D",
  done: "#00C389",
  idle: "#8A8A8A",
};

export function MigrationView({ live, startedAtLabel }: Props) {
  const {
    status,
    tables,
    milestones,
    series,
    kpis,
    totals,
    activeMode,
    currentBytesProgress,
  } = live;

  return (
    <>
      {/* KPI strip — labels and units swap based on activeMode ('rows' for
          direct-path tables, 'bytes' for s3-staged tables in flight). */}
      <div className="kpi-row">
        <div className="kpi spark">
          <span className="kpi-label">
            {activeMode === "bytes" ? "MB / sec" : "Rows / sec"}
          </span>
          <div className="kpi-value accent">
            {status === "running"
              ? activeMode === "bytes"
                ? fmtMBShort(kpis.inst)
                : fmtRowsShort(kpis.inst).replace(/\.0$/, "")
              : "—"}
            <span className="unit">
              {activeMode === "bytes" ? "MB/s" : "r/s"}
            </span>
          </div>
          <div className="kpi-sub">
            {activeMode === "bytes"
              ? `avg ${fmtMBShort(kpis.cum)} MB/s · last 60s`
              : `avg ${fmtRowsShort(kpis.cum)} r/s · last 60s`}
          </div>
          <div className="spark-wrap">
            <Sparkline data={series} color={SPARK_COLORS[status]} />
          </div>
        </div>

        <div className="kpi">
          <span className="kpi-label">ETA</span>
          <div className="kpi-value">
            {status === "done"
              ? "—"
              : status === "failed"
                ? "—"
                : status === "paused"
                  ? "paused"
                  : fmtSec(kpis.etaSec)}
          </div>
          <div className="kpi-sub">
            {status === "running"
              ? activeMode === "bytes" && currentBytesProgress
                ? `${fmtBytesShort(Math.max(0, currentBytesProgress.total_bytes - currentBytesProgress.bytes_done))} left`
                : `${fmtRowsShort(totals.total - totals.done)} rows left`
              : status === "paused"
                ? "resume to continue"
                : status === "done"
                  ? "finished"
                  : "stopped"}
          </div>
        </div>

        <div className="kpi">
          <span className="kpi-label">Elapsed</span>
          <div className="kpi-value">{fmtSec(kpis.elapsedSec)}</div>
          <div className="kpi-sub">started {startedAtLabel}</div>
        </div>

        <div className="kpi">
          <span className="kpi-label">Tables</span>
          <div className="kpi-value">
            {kpis.tablesDone}
            <span className="unit" style={{ color: "var(--fg-subtle)" }}>
              /{kpis.tablesTotal}
            </span>
          </div>
          <div className="kpi-sub">
            {kpis.activeTables > 0
              ? `${kpis.activeTables} running`
              : status === "failed"
                ? "stopped"
                : status === "done"
                  ? "all done"
                  : "—"}
          </div>
        </div>
      </div>

      {/* Overall progress bar */}
      <div className="overall">
        <div className="overall-head">
          <span>Overall progress</span>
          <span>
            <span className="total">{fmtRows(totals.done)}</span>{" "}
            <span style={{ color: "#5A5A5A" }}>/</span> {fmtRows(totals.total)} rows ·{" "}
            <span className="total">{fmtPct(kpis.pct)}</span>
          </span>
        </div>
        <div className="overall-bar">
          <div
            className="overall-fill"
            data-tone={status === "running" ? "" : status}
            style={{ width: `${kpis.pct}%` }}
          />
        </div>
      </div>

      {/* Tables list */}
      <div className="tables-section">
        <div className="section-head">
          <span className="eyebrow">Tables · {tables.length}</span>
          <span className="meta">
            {kpis.tablesDone} done · {kpis.activeTables} running ·{" "}
            {Math.max(
              0,
              tables.length -
                kpis.tablesDone -
                kpis.activeTables -
                tables.filter((t) => t.status === "failed").length,
            )}{" "}
            pending
          </span>
        </div>
        <div className="tables-list">
          {tables.map((t) => {
            const isStaged = t.strategy === "s3_stage" || t.strategy === "gcs_stage";
            const pct = t.total > 0 ? (t.rows_done / t.total) * 100 : 0;
            const stagedBytesPct =
              isStaged &&
              t.status === "running" &&
              currentBytesProgress?.table === t.name &&
              currentBytesProgress.total_bytes > 0
                ? (currentBytesProgress.bytes_done / currentBytesProgress.total_bytes) * 100
                : null;
            return (
              <div className="table-row" key={t.name}>
                <div className="tr-name">
                  <span className={`tr-status-dot ${t.status}`} />
                  <span>{t.name}</span>
                  {isStaged && <span className="tr-s3-badge">S3</span>}
                </div>
                {isStaged ? (
                  <PhaseIndicator phase={t.phase} status={t.status} />
                ) : (
                  <div className="tr-bar">
                    <div
                      className={`tr-bar-fill ${t.status}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                )}
                <div className="tr-rows">
                  {isStaged && stagedBytesPct !== null && currentBytesProgress ? (
                    <>
                      {fmtBytesShort(currentBytesProgress.bytes_done)}{" "}
                      <span style={{ color: "#3D3D3D" }}>/</span>{" "}
                      <span className="done-mark">
                        {fmtBytesShort(currentBytesProgress.total_bytes)}
                      </span>
                    </>
                  ) : (
                    <>
                      {fmtRowsShort(t.rows_done)}{" "}
                      <span style={{ color: "#3D3D3D" }}>/</span>{" "}
                      <span className="done-mark">{fmtRowsShort(t.total)}</span>
                    </>
                  )}
                </div>
                <div className={`tr-pct ${t.status === "running" ? "active" : ""}`}>
                  {isStaged && t.status === "running" && t.phase
                    ? t.phase === "loading" && stagedBytesPct !== null
                      ? `${stagedBytesPct.toFixed(0)}%`
                      : t.phase
                    : `${pct.toFixed(pct >= 100 ? 0 : 1)}%`}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Milestones (filtered events) */}
      <div className="milestones">
        <div className="section-head">
          <span className="eyebrow">Milestones · table transitions only</span>
          <span className="meta">filtered · {milestones.length} events</span>
        </div>
        <div className="milestones-list">
          {milestones.map((m) => (
            <div className="milestone" key={m.id}>
              <span className="milestone-ts">{m.t}</span>
              <span className={`milestone-tag ${m.k}`}>{m.tag}</span>
              <span className="milestone-msg">{m.msg}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

// ─── helpers (extracted from LiveRun.tsx unchanged) ──────────────────

const PHASE_ORDER = ["unloading", "staged", "loading", "validating"] as const;

function PhaseIndicator({
  phase,
  status,
}: {
  phase: TablePhase;
  status: TableStatus;
}) {
  let activeIdx = phase ? PHASE_ORDER.indexOf(phase as (typeof PHASE_ORDER)[number]) : -1;
  if (status === "done") activeIdx = PHASE_ORDER.length;
  if (status === "pending") activeIdx = -1;
  return (
    <div className="tr-bar-phases" role="progressbar" aria-label={phase ?? status}>
      {PHASE_ORDER.map((_, i) => {
        const cls =
          i < activeIdx ? "done" : i === activeIdx && status !== "done" ? "active" : "pending";
        return <div key={i} className={`tr-bar-phase ${cls}`} />;
      })}
    </div>
  );
}

function fmtBytesShort(n: number): string {
  if (!isFinite(n) || n <= 0) return "0 B";
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(0)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(0)} KB`;
  return `${n} B`;
}

function fmtMBShort(bytesPerSec: number): string {
  const mb = bytesPerSec / (1 << 20);
  if (mb >= 1000) return (mb / 1000).toFixed(2) + "G";
  if (mb >= 10) return mb.toFixed(0);
  return mb.toFixed(1);
}
