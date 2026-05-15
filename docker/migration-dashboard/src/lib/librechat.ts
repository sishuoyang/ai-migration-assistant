/**
 * LibreChat REST client used by the dashboard.
 *
 * Auth model (v0.8.5):
 *   POST /api/auth/login    → returns { token, user }, sets HttpOnly
 *                             refreshToken + token_provider cookies
 *   POST /api/auth/refresh  → returns new { token }, rotates cookies
 *   Bearer header           → required for /api/user, /api/convos, etc.
 *
 * Same-origin: LibreChat at `/`, dashboard at `/dashboard/`, both behind
 * the same nginx at https://localhost — so cookies set by these POSTs
 * are visible to the LibreChat iframe too, which is what makes the
 * iframe show up already logged in.
 *
 * Credentials match what `librechat-init` registers at startup.
 */

const DEMO_EMAIL = "admin@playground.local";
const DEMO_PASSWORD = "playground";

// Cached access token. Short-lived (~15 min by default); we refresh on
// 401 from fetchWithAuth.
let accessToken: string | null = null;
let inflight: Promise<string> | null = null;

export interface LoginResponse {
  token: string;
  user: { id: string; email: string; username?: string };
}

async function tryRefresh(): Promise<string | null> {
  try {
    const r = await fetch("/api/auth/refresh", {
      method: "POST",
      credentials: "same-origin",
    });
    if (!r.ok) return null;
    const body = (await r.json().catch(() => null)) as { token?: string } | null;
    return body?.token ?? null;
  } catch {
    return null;
  }
}

async function loginAsDemoUser(): Promise<string> {
  const r = await fetch("/api/auth/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: DEMO_EMAIL, password: DEMO_PASSWORD }),
  });
  if (!r.ok) {
    throw new Error(
      `LibreChat login failed: ${r.status} ${r.statusText} — ${await r
        .text()
        .catch(() => "")}`,
    );
  }
  const body = (await r.json()) as LoginResponse;
  return body.token;
}

/** Returns a valid Bearer token, refreshing/logging in as needed.
 *  Concurrent callers share the same in-flight request so we don't hit
 *  /api/auth/login multiple times on a cold page load. */
export async function getAccessToken(force = false): Promise<string> {
  if (accessToken && !force) return accessToken;
  if (inflight) return inflight;
  inflight = (async () => {
    const refreshed = await tryRefresh();
    if (refreshed) {
      accessToken = refreshed;
      return refreshed;
    }
    const fresh = await loginAsDemoUser();
    accessToken = fresh;
    return fresh;
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

/** Bootstrap LibreChat auth so the iframe loads pre-authenticated. */
export async function ensureAuthenticated(): Promise<void> {
  await getAccessToken();
}

/** Authenticated fetch wrapper. Retries once with a force-refreshed
 *  token on 401, so the dashboard recovers transparently when the
 *  short-lived access token expires. */
export async function fetchWithAuth(
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  const send = async (token: string) => {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${token}`);
    return fetch(input, { ...init, headers, credentials: "same-origin" });
  };
  let r = await send(await getAccessToken());
  if (r.status === 401) {
    r = await send(await getAccessToken(true));
  }
  return r;
}
