import { useEffect, useRef, useState, type DragEvent } from "react";
import { useOlapQueries } from "../context/OlapQueriesContext";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function OlapQueriesDialog({ open, onClose }: Props) {
  const { queries, defaults, setQueries, resetToDefaults } = useOlapQueries();
  const [draft, setDraft] = useState<string>(queries);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Re-sync the local draft each time the dialog opens.
  useEffect(() => {
    if (open) setDraft(queries);
  }, [open, queries]);

  // Esc-to-close.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const handleDrop = (e: DragEvent<HTMLTextAreaElement>) => {
    const file = e.dataTransfer.files?.[0];
    if (!file || !file.name.toLowerCase().endsWith(".sql")) return;
    e.preventDefault();
    file.text().then((text) => setDraft(text)).catch(() => {});
  };

  const handleSave = () => {
    setQueries(draft);
    onClose();
  };

  const handleReset = () => {
    resetToDefaults();
    setDraft(defaults);
  };

  return (
    <div className="mh-modal-backdrop" onClick={onClose}>
      <div className="mh-modal" onClick={(e) => e.stopPropagation()}>
        <header className="mh-modal-head">
          <div>
            <h2>Analytical Queries</h2>
            <p>
              Drives steps 1, 3, and 4. Edits stay in this session only —
              refresh resets to your source's defaults. Drop a{" "}
              <code style={{ fontFamily: "var(--font-mono)" }}>.sql</code>{" "}
              file to replace the contents.
            </p>
          </div>
          <button className="mh-modal-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <textarea
          ref={textareaRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={handleDrop}
          spellCheck={false}
        />

        <footer className="mh-modal-foot">
          <button className="btn" onClick={handleReset}>
            Reset to defaults
          </button>
          <div className="right">
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={handleSave}>
              Save
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
