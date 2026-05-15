/**
 * Polls /api/runs/{id}/benchmarks on mount + refetches on each
 * `benchmark_row` / `benchmark_done` SSE event.
 *
 * Mirrors `useValidations`. Kept as a separate hook so the Migration
 * tab can render without paying for benchmark/validation fetches that
 * are irrelevant to it. Both small-list hooks open their own
 * EventSource (third one alongside useLiveRun's) — simpler than
 * threading a shared subscription through React context.
 */
import { useCallback, useEffect, useState } from "react";

import { api, type BenchmarkRow } from "../lib/api";

export interface UseBenchmarksResult {
  rows: BenchmarkRow[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const EMPTY: UseBenchmarksResult = {
  rows: [],
  loading: false,
  error: null,
  refresh: () => {},
};

export function useBenchmarks(runId: string | null): UseBenchmarksResult {
  const [rows, setRows] = useState<BenchmarkRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchOnce = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.listBenchmarks(id);
      setRows(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!runId) {
      setRows([]);
      return;
    }
    void fetchOnce(runId);
  }, [runId, fetchOnce]);

  useEffect(() => {
    if (!runId) return;
    const es = api.subscribeEvents(runId, 0, (ev) => {
      if (ev.kind === "benchmark_row" || ev.kind === "benchmark_done") {
        void fetchOnce(runId);
      }
    });
    return () => es.close();
  }, [runId, fetchOnce]);

  if (!runId) return EMPTY;
  return {
    rows,
    loading,
    error,
    refresh: () => {
      if (runId) void fetchOnce(runId);
    },
  };
}
