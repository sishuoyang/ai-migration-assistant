import { Icon, ICONS } from "./Icon";

interface Props {
  collapsed: boolean;
  onClick: () => void;
  title?: string;
}

export function CollapseToggle({ collapsed, onClick, title }: Props) {
  return (
    <button
      className="collapse-toggle"
      data-collapsed={collapsed}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      title={title || (collapsed ? "Expand" : "Collapse")}
      aria-label={collapsed ? "Expand" : "Collapse"}
    >
      <Icon d={ICONS.chevron} size={14} />
    </button>
  );
}
