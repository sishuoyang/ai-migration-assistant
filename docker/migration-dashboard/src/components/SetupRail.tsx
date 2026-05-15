/**
 * Setup → Conversation → Steps. Three CollapsibleBlocks stacked.
 *
 * Ported from setup-rail.jsx, with:
 *   - Source dropdown populated from /api/mk/sources
 *   - Database input editable, defaulted from the picked source
 *   - Queries button opens the OlapQueriesDialog modal
 *   - Conversation dropdown shows recent chats; selection navigates iframe
 *   - Step tiles fire prompts into the iframe via existing chatInject + prompts
 */
import { useEffect, useState } from "react";
import type { RefObject } from "react";
import { CollapsibleBlock } from "./CollapsibleBlock";
import { Icon, ICONS } from "./Icon";
import { OlapQueriesDialog } from "./OlapQueriesDialog";
import type { Conversation, SourceMeta, StepId } from "../types";
import { STEPS } from "../types";
import { api } from "../lib/api";
import { useOlapQueries } from "../context/OlapQueriesContext";
import {
  fetchPromptTemplate,
  PromptNotAuthoredError,
  substitutePrompt,
} from "../lib/prompts";
import { injectPromptIntoChat } from "../lib/chatInject";

interface Props {
  sources: SourceMeta[];
  source: string;
  database: string;
  onSourceChange: (id: string) => void;
  onDatabaseChange: (db: string) => void;

  conversationId: string | null;
  onConversationChange: (next: string | null) => void;

  iframeRef: RefObject<HTMLIFrameElement>;

  collapsedBlocks: { setup: boolean; conversation: boolean; steps: boolean };
  toggleBlock: (key: "setup" | "conversation" | "steps") => void;
}

export function SetupRail({
  sources,
  source,
  database,
  onSourceChange,
  onDatabaseChange,
  conversationId,
  onConversationChange,
  iframeRef,
  collapsedBlocks,
  toggleBlock,
}: Props) {
  const isC = (key: keyof Props["collapsedBlocks"]) => !!collapsedBlocks[key];

  // ─── Setup block state ─────────────────────────────────────
  const [dialogOpen, setDialogOpen] = useState(false);
  const { queries, isCustom } = useOlapQueries();
  const olapCount = queries
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--")).length;

  // Source-database listing: fetched per source via the backend's source
  // connector. `null` = loading. Empty array OR error = fall back to a
  // free-text input so partners with broken creds can still type a name.
  const [dbList, setDbList] = useState<string[] | null>(null);
  const [dbListError, setDbListError] = useState<string | null>(null);
  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    setDbList(null);
    setDbListError(null);
    api
      .listDatabases(source)
      .then((dbs) => {
        if (cancelled) return;
        setDbList(dbs);
        // If the current `database` value isn't in the list, pre-select
        // the first one — saves the partner a click in the common case.
        if (database && !dbs.includes(database) && dbs.length > 0) {
          onDatabaseChange(dbs[0]);
        } else if (!database && dbs.length > 0) {
          onDatabaseChange(dbs[0]);
        }
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const msg = e instanceof Error ? e.message : String(e);
        setDbList([]);  // signal "empty / error" → free-text fallback
        setDbListError(msg);
      });
    return () => {
      cancelled = true;
    };
    // We intentionally exclude `database` and `onDatabaseChange` from
    // the deps — re-listing should only fire on source change, not on
    // every keystroke (when the fallback input is in use).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  // ─── Conversation block state ──────────────────────────────
  const [convos, setConvos] = useState<Conversation[]>([]);
  useEffect(() => {
    let cancelled = false;
    const tick = () => {
      api
        .listConversations(25)
        .then((next) => {
          if (!cancelled) setConvos(next);
        })
        .catch(() => {});
    };
    tick();
    const id = setInterval(tick, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // ─── Step buttons state ────────────────────────────────────
  const [busyStep, setBusyStep] = useState<StepId | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);

  async function fireStep(step: StepId) {
    setBusyStep(step);
    setStepError(null);
    try {
      const template = await fetchPromptTemplate(source, step);
      const prompt = substitutePrompt(template, {
        source,
        database: database || "(unspecified)",
        olapQueries: queries || "-- (no analytical queries provided)",
      });
      const iframe = iframeRef.current;
      if (!iframe) throw new Error("Chat iframe is not ready yet");
      const r = injectPromptIntoChat(iframe, prompt);
      if (!r.ok) throw new Error(r.reason ?? "could not reach the chat textarea");
    } catch (e) {
      if (e instanceof PromptNotAuthoredError) {
        setStepError(
          `Step "${step}" hasn't been authored for ${e.source} yet — only Snowflake has the new 4-step prompts.`,
        );
      } else {
        setStepError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusyStep(null);
    }
  }

  // ─── Render ────────────────────────────────────────────────
  return (
    <div className="bottom-rail">
      <CollapsibleBlock
        title="Setup"
        meta="source · source database · queries"
        collapsed={isC("setup")}
        onToggle={() => toggleBlock("setup")}
      >
        <div className="setup-grid">
          <div className="field">
            <span className="field-label">Source</span>
            <select
              className="select"
              value={source}
              disabled={sources.length === 0}
              onChange={(e) => onSourceChange(e.target.value)}
            >
              {sources.length === 0 ? (
                <option value="">loading…</option>
              ) : (
                sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))
              )}
            </select>
          </div>
          <div className="field">
            {/* The SOURCE database (the one to migrate FROM). The target
                database on ClickHouse Cloud is named separately by the
                agent during step 1 — partners confirm it in chat.
                We fetch the live list of databases from the source
                connector; if the backend couldn't list (creds missing,
                connection failure), we fall back to a free-text input
                so the partner can still type a name. */}
            <span className="field-label">
              Source database
              {dbListError ? (
                <span
                  title={dbListError}
                  style={{
                    marginLeft: 6,
                    color: "var(--ch-amber)",
                    textTransform: "none",
                    fontWeight: 400,
                  }}
                >
                  · couldn't enumerate, type manually
                </span>
              ) : null}
            </span>
            {dbList === null ? (
              <select className="select" disabled>
                <option>loading…</option>
              </select>
            ) : dbList.length > 0 ? (
              <select
                className="select"
                value={dbList.includes(database) ? database : ""}
                onChange={(e) => onDatabaseChange(e.target.value)}
              >
                {!dbList.includes(database) && (
                  <option value="">— pick a database —</option>
                )}
                {dbList.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="input"
                value={database}
                onChange={(e) => onDatabaseChange(e.target.value)}
                placeholder="database to migrate from"
              />
            )}
          </div>
          <div className="field" style={{ justifyContent: "flex-end" }}>
            <span className="field-label">
              Queries{isCustom ? " · custom" : ""}
            </span>
            <button
              className="btn"
              style={{ height: 32 }}
              onClick={() => setDialogOpen(true)}
            >
              <Icon d={ICONS.edit} /> Edit · {olapCount} OLAP
            </button>
          </div>
        </div>
      </CollapsibleBlock>

      <CollapsibleBlock
        title="Conversation"
        meta="resumes on refresh"
        collapsed={isC("conversation")}
        onToggle={() => toggleBlock("conversation")}
      >
        <div className="convo-row">
          <select
            className="select"
            value={conversationId ?? "__new__"}
            onChange={(e) =>
              onConversationChange(e.target.value === "__new__" ? null : e.target.value)
            }
          >
            <option value="__new__">＋ New conversation</option>
            {conversationId &&
              !convos.find((c) => c.conversationId === conversationId) && (
                <option value={conversationId}>
                  (current) {conversationId.slice(0, 8)}…
                </option>
              )}
            {convos.map((c) => (
              <option key={c.conversationId} value={c.conversationId}>
                {(c.title || "(untitled)").slice(0, 60)} ·{" "}
                {fmtRelativeShort(c.updatedAt)}
              </option>
            ))}
          </select>
        </div>
      </CollapsibleBlock>

      <CollapsibleBlock
        title="Steps · click to fire prompt"
        meta="all six always clickable"
        collapsed={isC("steps")}
        onToggle={() => toggleBlock("steps")}
      >
        <div className="steps-grid">
          {STEPS.map((s) => {
            const busy = busyStep === s.id;
            return (
              <button
                key={s.id}
                className="step-tile"
                disabled={busyStep !== null}
                onClick={() => fireStep(s.id)}
              >
                <span className="num">{busy ? "…" : s.number}</span>
                <span className="title">{s.title}</span>
                <span className="sub">{s.short}</span>
              </button>
            );
          })}
        </div>
        {stepError && (
          <div
            style={{
              padding: "8px 12px 12px",
              fontSize: 11,
              color: "#FF8A8E",
            }}
          >
            ⚠ {stepError}
          </div>
        )}
      </CollapsibleBlock>

      <OlapQueriesDialog open={dialogOpen} onClose={() => setDialogOpen(false)} />
    </div>
  );
}

function fmtRelativeShort(iso: string): string {
  const diff = Math.max(0, Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
