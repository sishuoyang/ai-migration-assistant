/**
 * Benchmark tab content — table of (query, source ms, target ms,
 * speedup, rows) backed by GET /api/runs/{id}/benchmarks.
 *
 * Primary ms columns are **server-side engine execution time**
 * (network-neutral). When the wall-clock differs by more than ~50 ms
 * we surface it as a subline below the primary number so users can
 * see how much the network/TLS RTT added.
 *
 * Rendered when the user clicks the Benchmark tab in LiveRun. Stays
 * empty (with a helpful prompt) until the agent runs step 4.
 */
import type { BenchmarkRow } from "../lib/api";
import { fmtRows } from "../lib/fmt";

interface Props {
  rows: BenchmarkRow[];
  loading: boolean;
  error: string | null;
}

export function BenchmarkView({ rows, loading, error }: Props) {
  if (error) {
    return (
      <div className="tr-results-empty" data-tone="failed">
        <b>Couldn't load benchmark results:</b> {error}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="tr-results-empty">
        <div className="empty-title">No benchmark results yet</div>
        <div className="empty-sub">
          Click <b>step 4 — benchmark & optimize</b> in the chat. The
          agent runs <code>Benchmarker(...).benchmark(queries=[...])</code>,
          results land here live as each query is timed.
        </div>
      </div>
    );
  }

  const completed = rows.filter(
    (r) => r.source_ms != null && r.target_ms != null,
  );
  const speedups = completed
    .map((r) => (r.target_ms ? (r.source_ms ?? 0) / r.target_ms : null))
    .filter((s): s is number => s != null && isFinite(s) && s > 0);
  const avgSpeedup =
    speedups.length > 0
      ? speedups.reduce((a, b) => a + b, 0) / speedups.length
      : null;

  return (
    <div className="tr-results">
      <div className="section-head">
        <span className="eyebrow">
          Query benchmarks · {rows.length} quer{rows.length === 1 ? "y" : "ies"}
        </span>
        <span className="meta">
          {avgSpeedup != null
            ? `avg ${avgSpeedup.toFixed(1)}× faster (engine time)`
            : "—"}
          {loading && " · refreshing…"}
        </span>
      </div>
      <div className="tr-results-table-wrap">
        <table className="tr-results-table">
          <thead>
            <tr>
              <th className="num small">#</th>
              <th>Query</th>
              <th className="num" title="Server-side engine execution time on the source">
                Source (engine)
              </th>
              <th className="num" title="Server-side engine execution time on the target">
                Target (engine)
              </th>
              <th className="num">Speedup</th>
              <th className="center">Rows</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const speedup =
                r.source_ms != null && r.target_ms != null && r.target_ms > 0
                  ? r.source_ms / r.target_ms
                  : null;
              const rowsMatch =
                r.source_rows != null &&
                r.target_rows != null &&
                r.source_rows === r.target_rows;
              return (
                <tr key={r.query_n}>
                  <td className="num small">{r.query_n + 1}</td>
                  <td className="name" title={r.target_sql ?? r.source_sql ?? ""}>
                    {r.name}
                  </td>
                  <td className="num">
                    {fmtMs(r.source_ms, r.source_error)}
                    {fmtWallSubline(r.source_ms, r.source_wall_ms)}
                  </td>
                  <td className="num">
                    {fmtMs(r.target_ms, r.target_error)}
                    {fmtWallSubline(r.target_ms, r.target_wall_ms)}
                  </td>
                  <td className="num">
                    {speedup != null ? (
                      <span className={speedup >= 1 ? "speedup-up" : "speedup-down"}>
                        {speedup.toFixed(1)}×
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="center">
                    {r.source_rows == null && r.target_rows == null
                      ? "—"
                      : (
                        <span className={`match-mark ${rowsMatch ? "ok" : "bad"}`}>
                          {rowsMatch ? "✓" : "≠"}
                        </span>
                      )}
                    {(r.source_rows != null || r.target_rows != null) && (
                      <div className="tr-rows-detail">
                        {fmtRows(r.source_rows ?? 0)}
                        {" / "}
                        {fmtRows(r.target_rows ?? 0)}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.some((r) => r.source_error || r.target_error) && (
        <div className="tr-results-errs">
          {rows
            .filter((r) => r.source_error || r.target_error)
            .map((r) => (
              <div className="tr-results-err" key={`err-${r.query_n}`}>
                <b>{r.name}:</b>{" "}
                {r.source_error && (
                  <>
                    source —{" "}
                    <code style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
                      {r.source_error}
                    </code>{" "}
                  </>
                )}
                {r.target_error && (
                  <>
                    target —{" "}
                    <code style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
                      {r.target_error}
                    </code>
                  </>
                )}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function fmtMs(ms: number | null, error: string | null): string {
  if (error) return "ERR";
  if (ms == null) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  return `${ms.toFixed(0)} ms`;
}

function fmtWallSubline(
  primaryMs: number | null,
  wallMs: number | null,
) {
  if (primaryMs == null || wallMs == null) return null;
  const overhead = wallMs - primaryMs;
  if (overhead < 50) return null;  // sub-50ms RTT not worth surfacing
  const wallStr = wallMs >= 1000
    ? `${(wallMs / 1000).toFixed(2)} s`
    : `${wallMs.toFixed(0)} ms`;
  return (
    <div className="tr-wall-detail" title="time.monotonic() bracket — includes network/TLS RTT">
      wall: {wallStr}
    </div>
  );
}
