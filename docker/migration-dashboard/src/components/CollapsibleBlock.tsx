import type { ReactNode } from "react";
import { CollapseToggle } from "./CollapseToggle";

interface Props {
  title: string;
  meta?: ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}

/**
 * The "rail block" pattern used in the left rail. Each block has a header
 * that toggles a collapsed state. Body is hidden when collapsed via CSS
 * (.is-collapsed). Clicking anywhere on the header toggles.
 */
export function CollapsibleBlock({
  title,
  meta,
  collapsed,
  onToggle,
  children,
}: Props) {
  return (
    <div className={`rail-block ${collapsed ? "is-collapsed" : ""}`}>
      <div
        className="rail-head"
        onClick={onToggle}
        role="button"
        aria-expanded={!collapsed}
      >
        <div className="rail-head-left">
          <CollapseToggle collapsed={collapsed} onClick={onToggle} />
          <span className="rail-eyebrow">{title}</span>
        </div>
        <div className="rail-head-right">
          {meta ? <span className="rail-meta">{meta}</span> : null}
        </div>
      </div>
      {children}
    </div>
  );
}
