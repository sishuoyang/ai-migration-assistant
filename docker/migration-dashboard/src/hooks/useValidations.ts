/**
 * Polls /api/runs/{id}/validations on mount + refetches whenever the
 * SSE stream emits a validation event.
 *
 * Validation row counts are produced by the Python `Validator.validate()`
 * call the agent dispatches in step 3. The dashboard's Validation tab
 * consumes the returned `rows` to render its table.
 *
 * Refetch-on-event is the simplest approach: the list is small (one row
 * per migrated table, typically <=10) and Python writes them in the
 * exact order events fire — the GET picks up the current state without
 * us tracking incremental deltas client-side.
 */
import { useCallback, useEffect, useState } from "react";

import { api, type ValidationRow } from "../lib/api";

export interface UseValidationsResult {
  rows: ValidationRow[];
  loading: boolean;
  error: string | null;
  /** Force a refetch from the API — exposed for the rare "Refresh" button. */
  refresh: () => void;
}

const EMPTY: UseValidationsResult = {
  rows: [],
  loading: false,
  error: null,
  refresh: () => {},
};

export function useValidations(runId: string | null): UseValidationsResult {
  const [rows, setRows] = useState<ValidationRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchOnce = useCallback(
    async (id: string) => {
      setLoading(true);
      setError(null);
      try {
        const data = await api.listValidations(id);
        setRows(data);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  // Initial fetch + run-id change.
  useEffect(() => {
    if (!runId) {
      setRows([]);
      return;
    }
    void fetchOnce(runId);
  }, [runId, fetchOnce]);

  // SSE subscription — refetch the whole list when any validation
  // event arrives. Own EventSource (not shared with useLiveRun): the
  // dashboard sees 3 simultaneous SSE connections per active run,
  // which the migration-runner container handles without issue.
  useEffect(() => {
    if (!runId) return;
    const es = api.subscribeEvents(runId, 0, (ev) => {
      if (ev.kind === "validation_row" || ev.kind === "validation_done") {
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
