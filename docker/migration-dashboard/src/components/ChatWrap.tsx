import type { RefObject } from "react";
import { ChatFrame } from "./ChatFrame";

interface Props {
  iframeRef: RefObject<HTMLIFrameElement>;
  conversationId: string | null;
  /** Title shown in the chat header pill (e.g. "Snowflake → ClickHouse Cloud"). */
  title?: string;
}

/**
 * Light-themed chrome around the LibreChat iframe, matching the design's
 * `.chat-wrap` shell. Header has a conversation chip + small action
 * buttons (currently decorative — wiring them is a Phase 6+ task).
 */
export function ChatWrap({ iframeRef, conversationId, title }: Props) {
  return (
    <div className="chat-wrap">
      <div className="chat-head">
        <div className="convo-name">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" />
          </svg>
          {title ?? "Migration agent"}
        </div>
        <div className="actions">
          <button
            title="Copy conversation link"
            onClick={() => {
              if (conversationId) {
                navigator.clipboard
                  ?.writeText(`${window.location.origin}/c/${conversationId}`)
                  .catch(() => {});
              }
            }}
          >
            <svg
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M16 1H4a2 2 0 00-2 2v14" />
              <rect x="8" y="5" width="14" height="18" rx="2" />
            </svg>
          </button>
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        <ChatFrame
          iframeRef={iframeRef}
          conversationId={conversationId}
        />
      </div>
    </div>
  );
}
