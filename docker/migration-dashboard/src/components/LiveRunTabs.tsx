/**
 * Three-tab bar at the top of LiveRun's content area. Lets the partner
 * switch between live migration, row-count validation, and benchmark
 * results without leaving the dashboard rail.
 */
export type LiveRunTabKey = "migration" | "validation" | "benchmark";

interface Props {
  tab: LiveRunTabKey;
  onChange: (next: LiveRunTabKey) => void;
  counts: { validation: number; benchmark: number };
}

const TABS: { key: LiveRunTabKey; label: string }[] = [
  { key: "migration", label: "Migration" },
  { key: "validation", label: "Validation" },
  { key: "benchmark", label: "Benchmark" },
];

export function LiveRunTabs({ tab, onChange, counts }: Props) {
  return (
    <div className="tr-tabs" role="tablist">
      {TABS.map((t) => {
        const isActive = tab === t.key;
        const count =
          t.key === "validation"
            ? counts.validation
            : t.key === "benchmark"
              ? counts.benchmark
              : 0;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={`tr-tab ${isActive ? "active" : ""}`}
            onClick={() => onChange(t.key)}
          >
            <span className="tr-tab-label">{t.label}</span>
            {count > 0 && t.key !== "migration" && (
              <span className="tr-tab-badge">{count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
