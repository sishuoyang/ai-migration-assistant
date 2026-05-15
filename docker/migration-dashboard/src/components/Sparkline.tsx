/**
 * Smoothed sparkline using bezier curves between samples. Color and fill
 * gradient adapt to the current run status — see LiveRun for the
 * status-to-color mapping. SVG `id="sparkGrad"` is reused per-instance
 * via a unique gradientId so multiple sparklines on the same page don't
 * collide on the linearGradient name.
 */
import { useId } from "react";

interface Props {
  data: number[];
  height?: number;
  width?: number;
  color?: string;
  fillOpacity?: number;
}

export function Sparkline({
  data,
  height = 32,
  width = 200,
  color = "#FAFF69",
  fillOpacity = 0.16,
}: Props) {
  const gradientId = useId();
  if (!data || data.length === 0) return null;

  const max = Math.max(...data, 1);
  const min = 0;
  const n = data.length;
  const stepX = width / Math.max(1, n - 1);

  let path = "";
  data.forEach((v, i) => {
    const x = i * stepX;
    const y = height - ((v - min) / (max - min)) * (height - 4) - 2;
    if (i === 0) {
      path += `M ${x.toFixed(2)} ${y.toFixed(2)}`;
    } else {
      const px = (i - 1) * stepX;
      const py = height - ((data[i - 1] - min) / (max - min)) * (height - 4) - 2;
      const cx = (px + x) / 2;
      path += ` C ${cx.toFixed(2)} ${py.toFixed(2)}, ${cx.toFixed(2)} ${y.toFixed(2)}, ${x.toFixed(2)} ${y.toFixed(2)}`;
    }
  });
  const fill = path + ` L ${width.toFixed(2)} ${height} L 0 ${height} Z`;

  const lastX = (n - 1) * stepX;
  const lastY = height - ((data[n - 1] - min) / (max - min)) * (height - 4) - 2;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      width="100%"
      height={height}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={fillOpacity} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={fill} fill={`url(#${gradientId})`} />
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={lastX} cy={lastY} r={2.5} fill={color} />
    </svg>
  );
}
