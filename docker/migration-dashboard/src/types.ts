/** A single LibreChat conversation, surfaced in the dropdown so the
 *  partner can resume past chats instead of starting from scratch on
 *  every refresh. */
export interface Conversation {
  conversationId: string;
  title: string;
  agent_id?: string;
  endpoint?: string;
  createdAt: string;
  updatedAt: string;
}

/** A migration source as discovered by the backend at `/api/mk/sources`.
 *  The list is derived from `/sources/<id>/manifest.json` (with sensible
 *  defaults if the manifest is missing), so adding a source on disk
 *  shows up in the UI without rebuilding the dashboard. */
export interface SourceMeta {
  id: string;
  label: string;
  default_database: string;
  agent_name: string;
  /** LibreChat agent_id resolved from MongoDB at /api/sources time.
   *  When set, the dashboard navigates the chat iframe to
   *  `/c/new?endpoint=agents&agent_id=<id>` so the matching agent is
   *  pre-selected automatically when the partner picks this source. */
  agent_id?: string | null;
}

export type StepId =
  | "discover-and-design"
  | "migrate-data"
  | "validate"
  | "rewrite-queries"
  | "benchmark"
  | "optimize";

export interface StepMeta {
  id: StepId;
  number: 1 | 2 | 3 | 4 | 5 | 6;
  title: string;
  short: string;
}

export const STEPS: StepMeta[] = [
  {
    id: "discover-and-design",
    number: 1,
    title: "Discover & Design Schema",
    short: "Inspect source · propose ClickHouse target · run DDL",
  },
  {
    id: "migrate-data",
    number: 2,
    title: "Migrate Data",
    short: "Generate migrationkit script · stream progress to dashboard",
  },
  {
    id: "validate",
    number: 3,
    title: "Validate",
    short: "Row-count parity · source vs target",
  },
  {
    id: "rewrite-queries",
    number: 4,
    title: "Rewrite Queries",
    short: "Translate OLAP queries to ClickHouse SQL · in chat",
  },
  {
    id: "benchmark",
    number: 5,
    title: "Benchmark",
    short: "Time source vs target · per-query timings",
  },
  {
    id: "optimize",
    number: 6,
    title: "Optimize",
    short: "Add projections / MVs · re-benchmark",
  },
];
