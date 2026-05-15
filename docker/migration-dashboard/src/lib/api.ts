/**
 * Typed client for the migrationkit HTTP API.
 *
 * In production, all paths are same-origin under `/api/mk/` — the main
 * playground nginx forwards to migration-runner:8001 (Phase 4 unifies
 * everything under one origin). In `npm run dev`, vite.config.ts
 * proxies `/api/mk/*` to http://localhost:8006/api/*.
 */

const BASE = "/api/mk";

export type RunStatus =
  | "running"
  | "paused"
  | "done"
  | "failed"
  | "cancelled";

export type TableStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  | "cancelled";

export interface Run {
  run_id: string;
  source_type: string;
  source_database: string | null;
  target_database: string | null;
  status: RunStatus;
  started_at: string;
  ended_at: string | null;
  error: string | null;
}

/** Sub-phase for `strategy='s3_stage'` tables. NULL for `direct`-strategy
 *  tables (they have batches, not phases). Cleared back to NULL after a
 *  staged table completes validation. */
export type TablePhase =
  | "unloading"
  | "staged"
  | "loading"
  | "validating"
  | null;

export interface RunTable {
  run_id: string;
  table_name: string;
  total_rows: number | null;
  rows_done: number;
  status: TableStatus;
  strategy: string;
  phase?: TablePhase;
}

export interface RunDetail extends Run {
  tables: RunTable[];
  control_flag: "run" | "pause" | "cancel";
}

export interface RunEvent {
  id: number;
  ts: string;
  kind: string;
  payload: Record<string, unknown>;
}

/** One row of per-table row-count validation produced by `Validator.validate()`.
 *  `matched` is stored as 0/1 in SQLite — converted to boolean by the
 *  ValidationView at render time. */
export interface ValidationRow {
  run_id: string;
  table_name: string;
  source_rows: number | null;
  target_rows: number | null;
  matched: 0 | 1;
  error: string | null;
  checked_at: string;
}

/** One row of per-query timing comparison produced by `Benchmarker.benchmark()`.
 *  Either side's ms / rows is null when that side raised; the error
 *  column captures the reason. */
export interface BenchmarkRow {
  run_id: string;
  query_n: number;
  name: string;
  source_sql: string | null;
  target_sql: string | null;
  // Primary timing: server-side engine execution time (network-neutral).
  source_ms: number | null;
  target_ms: number | null;
  // Secondary diagnostic: `time.monotonic()` bracket around execute+fetch.
  // Gap vs *_ms reveals network/TLS overhead. Pre-upgrade rows: null.
  source_wall_ms: number | null;
  target_wall_ms: number | null;
  source_rows: number | null;
  target_rows: number | null;
  source_error: string | null;
  target_error: string | null;
  ran_at: string;
}

async function jget<T>(path: string): Promise<T> {
  const r = await fetch(`${BASE}${path}`, { credentials: "same-origin" });
  if (!r.ok) {
    throw new Error(`${r.status} ${r.statusText}: ${await r.text()}`);
  }
  return r.json() as Promise<T>;
}

async function jsend<T>(path: string, method: "POST" | "DELETE"): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method,
    credentials: "same-origin",
  });
  if (!r.ok) {
    throw new Error(`${r.status} ${r.statusText}: ${await r.text()}`);
  }
  return r.json() as Promise<T>;
}

import type { Conversation, SourceMeta } from "../types";
import { fetchWithAuth } from "./librechat";

export const api = {
  listRuns: () => jget<Run[]>("/runs"),
  getRun: (id: string) => jget<RunDetail>(`/runs/${encodeURIComponent(id)}`),
  health: () => jget<{ status: string }>("/health"),
  listSources: () => jget<SourceMeta[]>("/sources"),

  listValidations: (id: string) =>
    jget<ValidationRow[]>(`/runs/${encodeURIComponent(id)}/validations`),
  listBenchmarks: (id: string) =>
    jget<BenchmarkRow[]>(`/runs/${encodeURIComponent(id)}/benchmarks`),

  /** Resolve a LibreChat conversation pre-bound to the source's
   *  agent. Reuses the most recent existing conversation for that
   *  agent if any, otherwise creates a fresh one. The returned
   *  `conversation_id` is used as the iframe `/c/<id>` URL so the
   *  agent shows up pre-selected. */
  async conversationForSource(src: string): Promise<{
    conversation_id: string;
    agent_id: string;
    reused: boolean;
  }> {
    const r = await fetch(
      `${BASE}/sources/${encodeURIComponent(src)}/conversation`,
      { method: "POST", credentials: "same-origin" },
    );
    if (!r.ok) {
      throw new Error(`${r.status} ${r.statusText}: ${await r.text()}`);
    }
    return r.json();
  },

  /** Source-side database enumeration (uses the source connector to
   *  list visible databases). Backend caches for 5 min; pass
   *  `refresh=true` to bust. Surfaces a typed error so the UI can
   *  fall back to a free-text input if creds are missing or the
   *  connection fails. */
  async listDatabases(src: string, refresh = false): Promise<string[]> {
    const url = `/sources/${encodeURIComponent(src)}/databases${refresh ? "?refresh=true" : ""}`;
    return jget<string[]>(url);
  },

  /** Fetch the user's conversations from LibreChat. Requires the demo
   *  Bearer token; tokens are managed by lib/librechat.ts. */
  async listConversations(pageSize = 25): Promise<Conversation[]> {
    const r = await fetchWithAuth(`/api/convos?pageNumber=1&pageSize=${pageSize}`);
    if (!r.ok) {
      throw new Error(`${r.status} ${r.statusText}: ${await r.text().catch(() => "")}`);
    }
    const body = (await r.json()) as { conversations?: Conversation[] };
    return body.conversations ?? [];
  },

  pauseRun: (id: string) =>
    jsend<{ run_id: string; flag: string }>(`/runs/${encodeURIComponent(id)}/pause`, "POST"),
  resumeRun: (id: string) =>
    jsend<{ run_id: string; flag: string }>(`/runs/${encodeURIComponent(id)}/resume`, "POST"),
  cancelRun: (id: string) =>
    jsend<{ run_id: string; flag: string }>(`/runs/${encodeURIComponent(id)}/cancel`, "POST"),
  deleteRun: (id: string) =>
    jsend<{ run_id: string; deleted: boolean }>(`/runs/${encodeURIComponent(id)}`, "DELETE"),

  /** Subscribe to SSE events. Returns an EventSource — caller is
   *  responsible for calling `.close()` when done.
   *
   *  The browser's EventSource auto-reconnects on stream close with a
   *  ~3 s retry delay, indefinitely. If the server is misbehaving
   *  (e.g., closing on every connection), that loop churns HTTP
   *  buffers and parser state forever; over an open dashboard tab
   *  it's a measurable memory cost. We install an `onerror` handler
   *  that gives up after a streak of failures so the dashboard can
   *  fail visibly instead of bleeding memory silently. */
  subscribeEvents(runId: string, since: number, onEvent: (e: RunEvent) => void): EventSource {
    const url = `${BASE}/runs/${encodeURIComponent(runId)}/events?since=${since}`;
    const es = new EventSource(url, { withCredentials: false });
    let consecutiveErrors = 0;
    es.onmessage = (msg) => {
      consecutiveErrors = 0;  // reset on any successful frame
      try {
        onEvent(JSON.parse(msg.data) as RunEvent);
      } catch {
        /* ignore non-JSON lines (heartbeats) */
      }
    };
    es.onerror = () => {
      // EventSource.onerror fires both for transient errors (browser
      // will retry) AND for permanent closures. Count consecutive
      // errors and bail out so a dead/closed server can't keep us in
      // a reconnect loop forever.
      consecutiveErrors += 1;
      if (consecutiveErrors >= 5) {
        es.close();
      }
    };
    return es;
  },
};

export function isTerminal(status: RunStatus): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}
