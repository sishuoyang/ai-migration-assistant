import { useEffect, useRef, useState, type RefObject } from "react";
import { ensureAuthenticated } from "../lib/librechat";

interface Props {
  /** Lifted to App so step-button code can inject into the same iframe. */
  iframeRef: RefObject<HTMLIFrameElement>;
  /** Which conversation to load. `null` → /c/new (fresh chat).
   *  Agent pre-selection happens via the conversation document's
   *  stored `agent_id` — App.tsx resolves a conversation per source
   *  via POST /api/sources/{src}/conversation before setting this. */
  conversationId: string | null;
}

/**
 * Embedded LibreChat. Three responsibilities:
 *
 *   1. Bootstrap an auth cookie (playground demo creds) before mounting
 *      so the chat is pre-authenticated.
 *   2. Hide LibreChat's nav sidebar + history list so the partner sees
 *      ONE conversation (owned by the dashboard) rather than a list of
 *      past chats. Same-origin lets us inject CSS into the iframe's
 *      document directly — no nginx sub_filter or LibreChat fork.
 *   3. (Phase 5) Drive the conversation lifecycle — pick the right
 *      agent for the selected source, create the conversation, point
 *      the iframe at it, fire step-button prompts via REST.
 */
export function ChatFrame({ iframeRef, conversationId }: Props) {
  const [phase, setPhase] = useState<"booting" | "ready" | "error">("booting");
  const [error, setError] = useState<string | null>(null);

  // Track the current iframe-load observer + its disconnect timer so
  // we can tear them down BEFORE the next load installs a new pair.
  // Without these refs, every iframe navigation (source switch →
  // new `src`) leaks the previous load's observer for 30 s — and the
  // observer's closure pins `doc.body`, which pins the previous
  // LibreChat document's entire JS heap (~200–500 MB). Rapid source
  // switching during the 30 s window compounded several pinned
  // documents at once, climbing into multi-GB territory in the tab.
  const observerRef = useRef<MutationObserver | null>(null);
  const observerTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await ensureAuthenticated();
        if (!cancelled) setPhase("ready");
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          setPhase("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Clean up any in-flight observer when the component unmounts —
  // covers cases where the dashboard tears down (e.g., HMR, route
  // change) before the 30 s timeout fires.
  useEffect(() => {
    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
        observerRef.current = null;
      }
      if (observerTimeoutRef.current) {
        clearTimeout(observerTimeoutRef.current);
        observerTimeoutRef.current = null;
      }
    };
  }, []);

  // After every iframe (re)load, inject CSS + structurally hide all
  // siblings of the chat column. LibreChat renders client-side so we
  // run a MutationObserver to apply once the chat textarea exists.
  const handleLoad = () => {
    // Tear down the previous iframe load's observer + timer BEFORE
    // installing new ones. The previous closure was pinning the
    // previous document (and everything reachable from it).
    if (observerRef.current) {
      observerRef.current.disconnect();
      observerRef.current = null;
    }
    if (observerTimeoutRef.current) {
      clearTimeout(observerTimeoutRef.current);
      observerTimeoutRef.current = null;
    }

    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    injectHideSidebarCss(doc);

    const tryCollapse = () => collapseChatLayout(doc);
    if (tryCollapse()) return;

    const observer = new MutationObserver(() => {
      if (tryCollapse()) {
        observer.disconnect();
        if (observerRef.current === observer) observerRef.current = null;
      }
    });
    observer.observe(doc.body, { childList: true, subtree: true });
    observerRef.current = observer;
    // Bail after 30 s if we never find the chat input — let CSS do its
    // best. Store the timeout id so we can clear it on the next load
    // (otherwise rapid reloads stack timeouts and pin extra docs).
    observerTimeoutRef.current = setTimeout(() => {
      observer.disconnect();
      if (observerRef.current === observer) observerRef.current = null;
      observerTimeoutRef.current = null;
    }, 30_000);
  };

  if (phase === "booting") {
    return (
      <div className="chat-status">
        <span>Signing in to LibreChat…</span>
      </div>
    );
  }
  if (phase === "error") {
    return (
      <div className="chat-status chat-status-error">
        <span>⚠ {error}</span>
        <a href="/" target="_blank" rel="noreferrer">
          Open LibreChat in a new tab →
        </a>
      </div>
    );
  }

  // Setting iframe `src` via prop reloads the iframe whenever
  // conversationId changes. When LibreChat internally navigates from
  // /c/new to /c/<real-id> after the first message, App.tsx's polling
  // picks up the new id and updates this prop with the SAME value the
  // iframe is already showing — React doesn't re-set the attribute, so
  // the iframe doesn't reload.
  //
  // Agent pre-selection: App.tsx resolves a conversation for the
  // active Source via the backend before passing it here, so loading
  // /c/<id> presents the right agent (LibreChat reads the stored
  // agent_id from the conversation document).
  const src = `/c/${conversationId ?? "new"}`;

  return (
    // `key={src}` is intentional: when the partner switches sources
    // we want React to UNMOUNT the previous iframe DOM element (not
    // just swap its `src`). Unmounting forces the browser to dispose
    // the old contentDocument and everything reachable from it — a
    // belt-and-braces companion to the observer cleanup above. Same
    // `src` between renders keeps the same key, so React preserves
    // the iframe and no unnecessary reload happens (e.g., when
    // App.tsx's polling re-confirms the same conversationId).
    <iframe
      key={src}
      ref={iframeRef}
      src={src}
      title="LibreChat"
      onLoad={handleLoad}
      className="chat-iframe"
      allow="clipboard-read; clipboard-write; fullscreen"
    />
  );
}

const STYLE_ID = "migrationkit-hide-chrome";
const COLLAPSED_FLAG = "__migrationkitCollapsed";

/**
 * Hides LibreChat's nav sidebar (history list) and the resize handles.
 * The actual layout-collapse work happens in `collapseChatLayout` which
 * walks up from the chat textarea — this CSS is best-effort + a
 * fallback for elements we can't reach structurally.
 */
function injectHideSidebarCss(doc: Document) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    /* Wide nav (history list) */
    nav:has([data-testid="nav-new-chat-button"]),
    aside:has([data-testid="nav-new-chat-button"]),
    div:has(> nav [data-testid="nav-new-chat-button"]),
    div:has(> [data-testid="nav-new-chat-button"]) { display: none !important; }
    body nav { display: none !important; }

    /* Nav-rail (collapsed-state icon strip) — aria-labelled in i18n */
    [aria-label*="Nav" i],
    [aria-label*="navigation" i],
    [aria-label*="control panel" i],
    [aria-label*="control_panel" i],
    [aria-label*="side panel" i] { display: none !important; }

    /* Resize handles between the nav/main/side panels */
    [data-panel-resize-handle-enabled],
    [data-resize-handle-active],
    [data-panel-resize-handle-id] { display: none !important; }

    /* Sidebar toggle buttons */
    [data-testid="close-sidebar-button"],
    [data-testid="open-sidebar-button"] { display: none !important; }
  `;
  doc.head.appendChild(style);
}

/**
 * Anchors on the chat message input (the most reliable element in
 * LibreChat — it's always rendered) and walks up the parent chain.
 * At each level, if the current element has siblings, those siblings
 * are sidebar / panel containers — hide them, then flex-fill the
 * chat column. Stops after the first level where the parent is wide
 * enough to be the main flex/resizable group (and not just a
 * tiny wrapper around the input).
 *
 * Returns true if it found the input and collapsed; false otherwise
 * (so the caller's MutationObserver keeps polling).
 */
function collapseChatLayout(doc: Document): boolean {
  if ((doc.body as unknown as Record<string, boolean>)[COLLAPSED_FLAG]) {
    return true;
  }

  const input =
    doc.querySelector('textarea[placeholder]') ??
    doc.querySelector('[contenteditable="true"]');
  if (!input) return false;

  let current: HTMLElement | null = input as HTMLElement;
  while (current && current.parentElement) {
    const parentEl: HTMLElement = current.parentElement;
    const siblings = Array.from(parentEl.children) as HTMLElement[];
    // Look for a level where this column has horizontal siblings AND
    // the parent is broad enough to be a layout container (not just
    // padding around the input).
    if (
      siblings.length > 1 &&
      parentEl.offsetWidth >= 500 &&
      siblings.some((s) => s !== current && s.offsetWidth >= 40)
    ) {
      for (const sibling of siblings) {
        if (sibling !== current) {
          sibling.style.setProperty("display", "none", "important");
        }
      }
      current.style.setProperty("flex", "1 1 100%", "important");
      current.style.setProperty("width", "100%", "important");
      current.style.setProperty("max-width", "none", "important");
      (doc.body as unknown as Record<string, boolean>)[COLLAPSED_FLAG] = true;
      return true;
    }
    current = parentEl;
  }
  return false;
}
