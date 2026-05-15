import { useEffect, useRef, useState } from "react";
import { Chrome } from "./components/Chrome";
import { SetupRail } from "./components/SetupRail";
import { LiveRun } from "./components/LiveRun";
import { ChatWrap } from "./components/ChatWrap";
import { OlapQueriesProvider } from "./context/OlapQueriesContext";
import { api, type Run } from "./lib/api";
import { useLiveRun, type DisplayStatus } from "./hooks/useLiveRun";
import type { SourceMeta } from "./types";

const LAST_CONV_KEY = "mk:lastConversationId";

interface CollapseState {
  hero: boolean;
  setup: boolean;
  conversation: boolean;
  steps: boolean;
}

export function App() {
  // ─── Sources (from backend) ────────────────────────────────
  const [sources, setSources] = useState<SourceMeta[] | null>(null);
  const [source, setSource] = useState<string>("");
  const [database, setDatabase] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    api
      .listSources()
      .then((list) => {
        if (cancelled) return;
        setSources(list);
        if (list.length > 0) {
          setSource(list[0].id);
          setDatabase(list[0].default_database);
        }
      })
      .catch(() => {
        if (!cancelled) setSources([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSourceChange = (next: string) => {
    setSource(next);
    const meta = sources?.find((s) => s.id === next);
    if (meta) setDatabase(meta.default_database);
    // Switching sources means switching agents. Ask the backend for
    // a conversation already bound to the new source's agent (reused
    // if recent, otherwise created fresh). The iframe navigates to
    // that conversation, and LibreChat presents the right agent in
    // the new-chat UI because the conversation document carries the
    // matching `agent_id`.
    //
    // URL params on `/c/new` are NOT honored by LibreChat v0.8.5 —
    // only `redirect_uri` is read. The pre-created-conversation path
    // is the reliable mechanism.
    (async () => {
      try {
        const r = await api.conversationForSource(next);
        setSelectedConvId(r.conversation_id);
        window.localStorage.setItem(LAST_CONV_KEY, r.conversation_id);
      } catch (e) {
        // If the backend can't bind a conversation (Mongo down, agent
        // missing), fall back to a fresh /c/new — partner picks the
        // agent manually. Don't block the source switch on this.
        console.warn("conversationForSource failed:", e);
        setSelectedConvId(null);
        window.localStorage.removeItem(LAST_CONV_KEY);
      }
    })();
  };

  // ─── Conversation (persists across refresh) ────────────────
  const [selectedConvId, setSelectedConvId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(LAST_CONV_KEY);
  });
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // Sync state ← iframe URL. When LibreChat creates a conversation after
  // the first message (path flips /c/new → /c/<uuid>) we capture the
  // new id so the picker reflects it and refresh resumes it.
  useEffect(() => {
    const id = window.setInterval(() => {
      const w = iframeRef.current?.contentWindow;
      if (!w) return;
      let path: string;
      try {
        path = w.location.pathname;
      } catch {
        return;
      }
      const m = path.match(/^\/c\/([^/?#]+)$/);
      if (!m) return;
      const id2 = m[1];
      if (id2 === "new") {
        if (selectedConvId !== null) {
          setSelectedConvId(null);
          window.localStorage.removeItem(LAST_CONV_KEY);
        }
        return;
      }
      if (id2 !== selectedConvId) {
        setSelectedConvId(id2);
        window.localStorage.setItem(LAST_CONV_KEY, id2);
      }
    }, 2000);
    return () => window.clearInterval(id);
  }, [selectedConvId]);

  const handleConversationChange = (next: string | null) => {
    setSelectedConvId(next);
    if (next === null) {
      window.localStorage.removeItem(LAST_CONV_KEY);
    } else {
      window.localStorage.setItem(LAST_CONV_KEY, next);
    }
  };

  // ─── Runs (list polled every 2 s) ──────────────────────────
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const list = await api.listRuns();
        if (cancelled) return;
        setRuns(list);
        // Auto-select the newest run when nothing is selected yet, or
        // when the selected run was deleted.
        if (
          !selectedRunId ||
          !list.some((r) => r.run_id === selectedRunId)
        ) {
          setSelectedRunId(list[0]?.run_id ?? null);
        }
      } catch {
        /* swallow — the LiveRun hook will show its own error */
      }
    };
    tick();
    const id = window.setInterval(tick, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [selectedRunId]);

  // Chrome status pill follows the displayed run's status.
  const liveForChrome = useLiveRun(selectedRunId);
  const displayedStatus: DisplayStatus = selectedRunId ? liveForChrome.status : "idle";

  // ─── Collapse state (independent per block) ────────────────
  const [collapsed, setCollapsed] = useState<CollapseState>({
    hero: false,
    setup: false,
    conversation: false,
    steps: false,
  });
  const toggleBlock = (key: keyof CollapseState) =>
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));

  return (
    <OlapQueriesProvider source={source}>
      <Chrome status={displayedStatus} />
      <div className="split">
        <div className="left-rail">
          <SetupRail
            sources={sources ?? []}
            source={source}
            database={database}
            onSourceChange={handleSourceChange}
            onDatabaseChange={setDatabase}
            conversationId={selectedConvId}
            onConversationChange={handleConversationChange}
            iframeRef={iframeRef}
            collapsedBlocks={{
              setup: collapsed.setup,
              conversation: collapsed.conversation,
              steps: collapsed.steps,
            }}
            toggleBlock={(k) => toggleBlock(k)}
          />
          <LiveRun
            runs={runs}
            selectedRunId={selectedRunId}
            onSelectRun={setSelectedRunId}
            collapsed={collapsed.hero}
            onToggleCollapsed={() => toggleBlock("hero")}
          />
        </div>
        <div className="right-pane">
          <ChatWrap
            iframeRef={iframeRef}
            conversationId={selectedConvId}
            title={sources?.find((s) => s.id === source)?.agent_name}
          />
        </div>
      </div>
    </OlapQueriesProvider>
  );
}
