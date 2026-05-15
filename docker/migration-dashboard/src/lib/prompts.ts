import type { StepId } from "../types";

const BASE = "/api/mk";

export async function fetchPromptTemplate(
  source: string,
  step: StepId,
): Promise<string> {
  const r = await fetch(`${BASE}/sources/${source}/prompts/${step}`, {
    credentials: "same-origin",
  });
  if (!r.ok) {
    if (r.status === 404) {
      throw new PromptNotAuthoredError(source, step);
    }
    throw new Error(`${r.status} ${r.statusText}: ${await r.text()}`);
  }
  return r.text();
}

export async function fetchDefaultOlapQueries(source: string): Promise<string> {
  const r = await fetch(`${BASE}/sources/${source}/default-queries`, {
    credentials: "same-origin",
  });
  if (!r.ok) {
    if (r.status === 404) return "-- (no default queries for this source)";
    throw new Error(`${r.status} ${r.statusText}: ${await r.text()}`);
  }
  return r.text();
}

export interface SubstituteVars {
  source: string;
  database: string;
  olapQueries: string;
}

export function substitutePrompt(
  template: string,
  vars: SubstituteVars,
): string {
  return template
    .replaceAll("{source}", vars.source)
    .replaceAll("{database}", vars.database)
    .replaceAll("{olap_queries}", vars.olapQueries);
}

export class PromptNotAuthoredError extends Error {
  source: string;
  step: StepId;
  constructor(source: string, step: StepId) {
    super(`Prompt "${step}" is not yet authored for source "${source}".`);
    this.source = source;
    this.step = step;
  }
}
