/**
 * Validation tab content — table of (table, source rows, target rows,
 * matched) backed by GET /api/runs/{id}/validations.
 *
 * Rendered when the user clicks the Validation tab in LiveRun. Stays
 * empty (with a helpful prompt) until the agent runs step 3.
 */
import type { ValidationRow } from "../lib/api";
import { fmtRows } from "../lib/fmt";

interface Props {
  rows: ValidationRow[];
  loading: boolean;
  error: string | null;
}

export function ValidationView({ rows, loading, error }: Props) {
  if (error) {
    return (
      <div className="tr-results-empty" data-tone="failed">
        <b>Couldn't load validation results:</b> {error}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="tr-results-empty">
        <div className="empty-title">No validation results yet</div>
        <div className="empty-sub">
          Click <b>step 3 — validate & rewrite</b> in the chat. The agent
          runs <code>Validator(...).validate()</code>, results land here
          live as each table is checked.
        </div>
      </div>
    );
  }

  const matched = rows.filter((r) => r.matched === 1 && !r.error).length;
  const mismatched = rows.filter((r) => r.matched === 0 && !r.error).length;
  const errored = rows.filter((r) => r.error).length;

  return (
    <div className="tr-results">
      <div className="section-head">
        <span className="eyebrow">
          Row-count validation · {rows.length} table{rows.length === 1 ? "" : "s"}
        </span>
        <span className="meta">
          {matched} matched · {mismatched} mismatched · {errored} errored
          {loading && " · refreshing…"}
        </span>
      </div>
      <div className="tr-results-table-wrap">
        <table className="tr-results-table">
          <thead>
            <tr>
              <th>Table</th>
              <th className="num">Source rows</th>
              <th className="num">Target rows</th>
              <th className="center">Match</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.table_name} data-state={rowState(r)}>
                <td className="name">{r.table_name}</td>
                <td className="num">
                  {r.source_rows == null ? "—" : fmtRows(r.source_rows)}
                </td>
                <td className="num">
                  {r.target_rows == null ? "—" : fmtRows(r.target_rows)}
                </td>
                <td className="center">
                  {r.error
                    ? (
                      <span className="match-mark err" title={r.error}>
                        ERR
                      </span>
                    )
                    : r.matched === 1
                      ? <span className="match-mark ok">✓</span>
                      : <span className="match-mark bad">✗</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {errored > 0 && (
        <div className="tr-results-errs">
          {rows
            .filter((r) => r.error)
            .map((r) => (
              <div className="tr-results-err" key={`err-${r.table_name}`}>
                <b>{r.table_name}:</b>{" "}
                <code style={{ fontFamily: "var(--font-mono)", fontSize: 11 }}>
                  {r.error}
                </code>
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

function rowState(r: ValidationRow): "ok" | "bad" | "err" {
  if (r.error) return "err";
  return r.matched === 1 ? "ok" : "bad";
}
