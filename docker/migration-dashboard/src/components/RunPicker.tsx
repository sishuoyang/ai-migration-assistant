import { useState } from "react";
import { Icon, ICONS } from "./Icon";
import { fmtRelative } from "../lib/fmt";
import type { Run } from "../lib/api";

interface Props {
  runs: Run[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Status used for the displayed selection (idle if no selection). */
  selectedStatus: string;
}

function splitId(id: string): [string, string] {
  // "snowflake-MIGRATION_DEMO-2026-05-13" → ["snowflake-MIGRATION_DEMO", "-2026-05-13"]
  const parts = id.split("-");
  if (parts.length <= 2) return [id, ""];
  return [parts.slice(0, 2).join("-"), "-" + parts.slice(2).join("-")];
}

export function RunPicker({ runs, selectedId, onSelect, selectedStatus }: Props) {
  const [open, setOpen] = useState(false);

  // Resolve the currently-displayed entry. If selectedId doesn't match
  // any run (e.g. just deleted), fall back to the first available.
  const selected = runs.find((r) => r.run_id === selectedId) ?? runs[0];

  // No runs yet — render a neutral placeholder.
  if (!selected) {
    return (
      <div className="run-picker">
        <button className="run-picker-btn" disabled>
          <span className="tinybadge idle">idle</span>
          <span className="rp-id">no runs yet</span>
        </button>
      </div>
    );
  }

  const [head, tail] = splitId(selected.run_id);
  const isCurrent = runs[0]?.run_id === selected.run_id;

  return (
    <div className="run-picker">
      <button
        className="run-picker-btn"
        data-open={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`tinybadge ${selectedStatus}`}>{selectedStatus}</span>
        <span className="rp-id">
          {head}
          <span className="dim">{tail}</span>
        </span>
        <span className="rp-chev">
          <Icon d={ICONS.chevron} size={12} />
        </span>
      </button>
      {open && (
        <>
          <div className="run-picker-backdrop" onClick={() => setOpen(false)} />
          <div className="run-picker-menu" role="listbox">
            <div className="run-picker-menu-head">
              <span>Run history · {runs.length}</span>
              <span className="meta">polls every 2s</span>
            </div>
            {runs.map((r, i) => {
              const [h, t] = splitId(r.run_id);
              // Treat the newest run as "current" — matches what the
              // backend's polling would assert in the design's mock.
              const optIsCurrent = i === 0;
              const tone =
                r.status === "cancelled" ? "failed" : (r.status as string);
              return (
                <button
                  key={r.run_id}
                  className={`run-picker-option ${r.run_id === selected.run_id ? "selected" : ""}`}
                  onClick={() => {
                    onSelect(r.run_id);
                    setOpen(false);
                  }}
                >
                  <span className="opt-id">
                    {optIsCurrent && <span className="current-pill">current</span>}
                    <span>
                      {h}
                      <span className="dim">-{t.replace(/^-/, "")}</span>
                    </span>
                  </span>
                  <span className={`tinybadge ${tone}`}>{tone}</span>
                  <span className="opt-when">{fmtRelative(r.started_at)}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );

  // Note: `isCurrent` is computed but unused inside this body — LiveRun
  // already knows whether the selected id matches the most-recent run.
  // Kept as a separate prop in the original design, but here we derive
  // it from the same source.
  void isCurrent;
}
