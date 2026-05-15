/** Ported verbatim from the design handoff so KPI tile / mini-bar
 *  formatting matches the mocks pixel-for-pixel. */

export function fmtSec(s: number): string {
  if (!isFinite(s) || s <= 0) return "—";
  s = Math.round(s);
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m === 0) return `${r}s`;
  if (m < 60) return `${m}m ${String(r).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function fmtRowsShort(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

export function fmtRows(n: number): string {
  return n.toLocaleString("en-US");
}

export function fmtPct(n: number): string {
  return n.toFixed(1) + "%";
}

/** Relative-time formatter for run picker / dropdown labels. */
export function fmtRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const diff = Math.max(0, Date.now() - then) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 2) return "yesterday";
  return new Date(iso).toLocaleDateString();
}
