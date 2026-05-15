/**
 * Adapter hook: pulls live state from the migrationkit API + SSE event
 * stream and reshapes it to the shape the design's LiveRun component
 * expects.
 *
 * Returns:
 *   - status: idle | running | paused | done | failed (cancelled folded into failed)
 *   - tables: per-table progress (with phase for s3-stage tables)
 *   - milestones: filtered event log (no batch_done / log / bytes_progress noise)
 *   - series: rolling sparkline samples — rows/sec OR bytes/sec depending on
 *             which table is currently active (activeMode)
 *   - activeMode: 'rows' | 'bytes' — derived from the currently-running
 *             table's strategy; the LiveRun UI reads this to swap KPI labels
 *   - currentBytesProgress: latest bytes_progress sample for the running
 *             staged table; UI shows "X MB / Y MB" during the load phase
 *   - kpis: derived metrics (instantaneous rate, ETA, etc.) interpreted
 *             per activeMode by the UI
 *   - totals: aggregated rows
 *   - run: the raw RunDetail (for header metadata: source, db, started_at)
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import type { RunDetail, RunEvent, RunTable, TablePhase } from "../lib/api";

export type DisplayStatus = "idle" | "running" | "paused" | "done" | "failed";
export type ActiveMode = "rows" | "bytes";

export interface DesignTable {
  name: string;
  total: number;
  rows_done: number;
  status: RunTable["status"];
  strategy: string;
  phase: TablePhase;
}

export type MilestoneKind = "info" | "start" | "done" | "pause" | "fail";

export interface DesignMilestone {
  id: number;
  t: string; // formatted HH:MM
  tag: string;
  k: MilestoneKind;
  msg: string;
}

export interface DesignKPIs {
  pct: number;
  inst: number;
  cum: number;
  etaSec: number;
  elapsedSec: number;
  tablesDone: number;
  tablesTotal: number;
  activeTables: number;
}

export interface BytesProgress {
  table: string;
  bytes_done: number;
  total_bytes: number;
  rows_done: number;
}

export interface LiveRunState {
  status: DisplayStatus;
  run: RunDetail | null;
  tables: DesignTable[];
  milestones: DesignMilestone[];
  series: number[];
  activeMode: ActiveMode;
  currentBytesProgress: BytesProgress | null;
  kpis: DesignKPIs;
  totals: { total: number; done: number };
  loading: boolean;
  error: string | null;
}

const SERIES_LEN = 60;

const EMPTY: LiveRunState = {
  status: "idle",
  run: null,
  tables: [],
  milestones: [],
  series: [],
  activeMode: "rows",
  currentBytesProgress: null,
  kpis: {
    pct: 0,
    inst: 0,
    cum: 0,
    etaSec: 0,
    elapsedSec: 0,
    tablesDone: 0,
    tablesTotal: 0,
    activeTables: 0,
  },
  totals: { total: 0, done: 0 },
  loading: false,
  error: null,
};

function mapStatus(s: RunDetail["status"], flag: RunDetail["control_flag"]): DisplayStatus {
  // control_flag=pause + status=running means the user clicked Pause but
  // the library hasn't reached the next batch boundary — show as paused.
  if (flag === "pause" && s === "running") return "paused";
  if (s === "cancelled") return "failed";
  return s as DisplayStatus;
}

function fmtHHMM(ts: string): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtBytes(n: number): string {
  if (n >= 1 << 30) return `${(n / (1 << 30)).toFixed(2)} GB`;
  if (n >= 1 << 20) return `${(n / (1 << 20)).toFixed(1)} MB`;
  if (n >= 1 << 10) return `${(n / (1 << 10)).toFixed(1)} KB`;
  return `${n} B`;
}

function eventToMilestone(ev: RunEvent): DesignMilestone | null {
  switch (ev.kind) {
    case "started":
      return {
        id: ev.id,
        t: fmtHHMM(ev.ts),
        tag: "start",
        k: "info",
        msg: `Run started · ${(ev.payload as any).source_type ?? ""} → ${(ev.payload as any).target_database ?? ""}`,
      };
    case "table_done": {
      const p = ev.payload as any;
      const stageLabel =
        p.strategy === "s3_stage"
          ? "S3"
          : p.strategy === "gcs_stage"
            ? "GCS"
            : null;
      const extra =
        stageLabel && p.total_bytes
          ? ` · ${fmtBytes(p.total_bytes)} via ${stageLabel}`
          : "";
      return {
        id: ev.id,
        t: fmtHHMM(ev.ts),
        tag: "done",
        k: "done",
        msg: `${p.table} complete · ${Number(p.total_rows ?? 0).toLocaleString()} rows${extra}`,
      };
    }
    case "phase_started": {
      const p = ev.payload as any;
      const table = p.table;
      switch (p.phase) {
        case "unloading":
          return {
            id: ev.id, t: fmtHHMM(ev.ts), tag: "unload", k: "start",
            msg: `${table} · unloading to S3`,
          };
        case "staged":
          return {
            id: ev.id, t: fmtHHMM(ev.ts), tag: "staged", k: "done",
            msg: `${table} · staged${p.total_bytes ? ` (${fmtBytes(p.total_bytes)}` : ""}${p.file_count ? `, ${p.file_count} files)` : p.total_bytes ? ")" : ""}`,
          };
        case "loading":
          return {
            id: ev.id, t: fmtHHMM(ev.ts), tag: "load", k: "start",
            msg: `${table} · loading from S3`,
          };
        case "validating":
          return {
            id: ev.id, t: fmtHHMM(ev.ts), tag: "verify", k: "info",
            msg: `${table} · validating row counts`,
          };
      }
      return null;
    }
    case "paused":
      return { id: ev.id, t: fmtHHMM(ev.ts), tag: "pause", k: "pause", msg: "Paused at batch boundary" };
    case "resumed":
      return { id: ev.id, t: fmtHHMM(ev.ts), tag: "info", k: "info", msg: "Resumed" };
    case "cancelled":
      return { id: ev.id, t: fmtHHMM(ev.ts), tag: "fail", k: "fail", msg: "Cancelled" };
    case "failed": {
      const err = (ev.payload as any).error;
      return { id: ev.id, t: fmtHHMM(ev.ts), tag: "fail", k: "fail", msg: err ? `Failed · ${err}` : "Failed" };
    }
    case "done":
      return { id: ev.id, t: fmtHHMM(ev.ts), tag: "done", k: "done", msg: "Run finished" };
    case "step_validated":
      return { id: ev.id, t: fmtHHMM(ev.ts), tag: "info", k: "info", msg: "Step 3 (validate) acknowledged by agent" };
    case "step_benchmarked":
      return { id: ev.id, t: fmtHHMM(ev.ts), tag: "info", k: "info", msg: "Step 4 (benchmark) acknowledged by agent" };
    default:
      // batch_done, bytes_progress, log are intentionally skipped.
      return null;
  }
}

export function useLiveRun(runId: string | null): LiveRunState {
  const [run, setRun] = useState<RunDetail | null>(null);
  const [milestones, setMilestones] = useState<DesignMilestone[]>([]);
  const [rowsSeries, setRowsSeries] = useState<number[]>(() => new Array(SERIES_LEN).fill(0));
  const [bytesSeries, setBytesSeries] = useState<number[]>(() => new Array(SERIES_LEN).fill(0));
  const [currentBytesProgress, setCurrentBytesProgress] = useState<BytesProgress | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  const lastEventIdRef = useRef<number>(0);
  const rowsSeriesRef = useRef<number[]>(new Array(SERIES_LEN).fill(0));
  const bytesSeriesRef = useRef<number[]>(new Array(SERIES_LEN).fill(0));
  // For bytes-rate computation we need the previous sample (per-table —
  // resets when a different table starts streaming).
  const lastBytesSampleRef = useRef<{
    table: string;
    bytes: number;
    tsMs: number;
  } | null>(null);

  // Reset accumulated state on every runId change.
  useEffect(() => {
    setMilestones([]);
    lastEventIdRef.current = 0;
    rowsSeriesRef.current = new Array(SERIES_LEN).fill(0);
    bytesSeriesRef.current = new Array(SERIES_LEN).fill(0);
    setRowsSeries(rowsSeriesRef.current);
    setBytesSeries(bytesSeriesRef.current);
    setCurrentBytesProgress(null);
    lastBytesSampleRef.current = null;
    if (!runId) {
      setRun(null);
      setError(null);
    }
  }, [runId]);

  // Poll the run detail every second while active.
  useEffect(() => {
    if (!runId) return;
    setLoading(true);
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const next = await api.getRun(runId);
        if (cancelled) return;
        setRun(next);
        setError(null);
        const status = next.status;
        const interval = status === "running" || status === "paused" ? 1000 : 5000;
        if (!cancelled) timer = setTimeout(tick, interval);
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          timer = setTimeout(tick, 3000);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

  // SSE subscription for events → milestones + sparkline samples.
  useEffect(() => {
    if (!runId) return;
    const es = api.subscribeEvents(runId, lastEventIdRef.current, (ev) => {
      lastEventIdRef.current = Math.max(lastEventIdRef.current, ev.id);

      // Append milestone if non-noisy.
      const m = eventToMilestone(ev);
      if (m) {
        setMilestones((prev) => [m, ...prev].slice(0, 100));
      }

      // Direct-path sparkline: rows/sec from batch_done.
      if (ev.kind === "batch_done") {
        const payload = ev.payload as { rows?: number; seconds?: number };
        const rows = payload.rows ?? 0;
        const seconds = payload.seconds ?? 0;
        const rate = seconds > 0 ? rows / seconds : 0;
        const next = rowsSeriesRef.current.slice(1);
        next.push(Math.round(rate));
        rowsSeriesRef.current = next;
        setRowsSeries(next);
      }

      // S3-stage sparkline: bytes/sec from bytes_progress deltas.
      if (ev.kind === "bytes_progress") {
        const p = ev.payload as {
          table: string;
          bytes_done: number;
          total_bytes: number;
          rows_done?: number;
        };
        const nowMs = new Date(ev.ts).getTime();
        const last = lastBytesSampleRef.current;
        let rate = 0;
        if (last && last.table === p.table) {
          const dtSec = (nowMs - last.tsMs) / 1000;
          if (dtSec > 0) {
            rate = Math.max(0, (p.bytes_done - last.bytes) / dtSec);
          }
        }
        lastBytesSampleRef.current = {
          table: p.table,
          bytes: p.bytes_done,
          tsMs: nowMs,
        };
        const next = bytesSeriesRef.current.slice(1);
        next.push(Math.round(rate));
        bytesSeriesRef.current = next;
        setBytesSeries(next);
        setCurrentBytesProgress({
          table: p.table,
          bytes_done: p.bytes_done,
          total_bytes: p.total_bytes,
          rows_done: p.rows_done ?? 0,
        });
      }

      // Clear the bytes-progress display once a staged table moves past
      // the loading phase — validating + table_done shouldn't show stale
      // "X MB / Y MB" data.
      if (ev.kind === "phase_started") {
        const p = ev.payload as { phase?: string };
        if (p.phase === "validating") {
          setCurrentBytesProgress(null);
          lastBytesSampleRef.current = null;
        }
      }
      if (ev.kind === "table_done") {
        setCurrentBytesProgress(null);
        lastBytesSampleRef.current = null;
      }
    });
    es.onerror = () => {
      // SSE auto-reconnects browser-side.
    };
    return () => es.close();
  }, [runId]);

  return useMemo<LiveRunState>(() => {
    if (!run) {
      return { ...EMPTY, loading, error };
    }
    const status = mapStatus(run.status, run.control_flag);
    const tables: DesignTable[] = run.tables.map((t) => ({
      name: t.table_name,
      total: t.total_rows ?? 0,
      rows_done: t.rows_done,
      status: t.status,
      strategy: t.strategy,
      phase: t.phase ?? null,
    }));
    const totalRows = tables.reduce((a, t) => a + t.total, 0);
    const doneRows = tables.reduce((a, t) => a + t.rows_done, 0);
    const elapsedSec = Math.max(
      0,
      Math.round(
        ((run.ended_at ? new Date(run.ended_at).getTime() : Date.now()) -
          new Date(run.started_at).getTime()) /
          1000,
      ),
    );

    // Active mode follows whichever table is currently running. Any
    // object-storage staging path (S3 or GCS) reports bytes; the
    // direct path reports rows.
    const runningTable = tables.find((t) => t.status === "running");
    const activeMode: ActiveMode =
      runningTable?.strategy === "s3_stage" ||
      runningTable?.strategy === "gcs_stage"
        ? "bytes"
        : "rows";
    const rawSeries = activeMode === "bytes" ? bytesSeries : rowsSeries;

    // After the run hits a terminal state no fresh batch_done /
    // bytes_progress events arrive, so the rolling buffer is frozen
    // at whatever the last 60 samples were. Rendering that historical
    // pattern reads as "still active" — flatten the series to zero
    // for terminal states so the sparkline visibly settles.
    const series = (status === "running" || status === "paused")
      ? rawSeries
      : new Array(SERIES_LEN).fill(0);

    // Instantaneous rate from recent series samples (any unit).
    const recent = series.slice(-10).filter((v) => v > 0);
    const inst = recent.length > 0
      ? Math.round(recent.reduce((a, b) => a + b, 0) / recent.length)
      : 0;
    const cum = elapsedSec > 0 ? Math.round(doneRows / elapsedSec) : 0;

    // ETA: in rows mode, use remaining-rows / rows-rate.
    // In bytes mode, use remaining-bytes (from currentBytesProgress) / bytes-rate.
    let etaSec = 0;
    if (status === "running" && inst > 0) {
      if (activeMode === "bytes" && currentBytesProgress) {
        const remainingBytes = Math.max(
          0,
          currentBytesProgress.total_bytes - currentBytesProgress.bytes_done,
        );
        etaSec = remainingBytes / inst;
      } else {
        const remainingRows = Math.max(0, totalRows - doneRows);
        etaSec = remainingRows / inst;
      }
    }

    const tablesDone = tables.filter((t) => t.status === "done").length;
    const tablesRunning = tables.filter((t) => t.status === "running").length;

    return {
      status,
      run,
      tables,
      milestones,
      series,
      activeMode,
      currentBytesProgress,
      totals: { total: totalRows, done: doneRows },
      kpis: {
        pct: totalRows > 0 ? (doneRows / totalRows) * 100 : 0,
        inst,
        cum,
        etaSec,
        elapsedSec,
        tablesDone,
        tablesTotal: tables.length,
        activeTables: tablesRunning,
      },
      loading,
      error,
    };
  }, [run, milestones, rowsSeries, bytesSeries, currentBytesProgress, loading, error]);
}
