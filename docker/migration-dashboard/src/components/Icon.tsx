/**
 * Inline SVG icon set ported from the design handoff. Each icon's
 * `d` attribute can contain multiple paths separated by `|`. Keep the
 * stroke-width and viewBox identical to the design so visual weights
 * match the mockups.
 */
interface IconProps {
  d: string;
  size?: number;
  className?: string;
}

export function Icon({ d, size = 13, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="square"
      strokeLinejoin="round"
      className={className}
    >
      {d.split("|").map((p, i) => (
        <path key={i} d={p} />
      ))}
    </svg>
  );
}

export const ICONS = {
  pause: "M6 4h4v16H6z|M14 4h4v16h-4z",
  play: "M6 4l14 8-14 8V4z",
  stop: "M5 5h14v14H5z",
  redo: "M3 3v6h6|M3 9a9 9 0 0114-3l3 3",
  rocket:
    "M5 13a4 4 0 014-4l5-5 5 5-5 5a4 4 0 01-4 4z|M9 14l-3 3-2-2 3-3",
  bolt: "M13 2L3 14h8l-1 8 10-12h-8l1-8z",
  history: "M3 3v5h5|M3.05 13a9 9 0 102.62-7.36L3 8|M12 7v5l4 2",
  chevron: "M6 9l6 6 6-6",
  edit: "M12 20h9|M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4z",
};
