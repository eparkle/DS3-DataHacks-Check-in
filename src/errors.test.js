import { describe, expect, it } from "vitest";
import {
  attentionText,
  classifyResponse,
  classifySession,
  describeFailure,
  httpCategory,
  isRetryable,
  queueStep,
  SERVER_RETRY_LIMIT,
} from "./errors.js";

// What supabase-js (postgrest-js) resolves to when fetch itself throws.
const fetchFailed = { data: null, error: { message: "TypeError: Failed to fetch", details: "", hint: "", code: "" }, status: 0, statusText: "" };
const http = (status, error = {}) => ({ data: null, error: { message: `HTTP ${status}`, code: "", hint: "", details: "", ...error }, status });

describe("classifyResponse", () => {
  it("ok", () => {
    expect(classifyResponse({ data: { status: "ok" }, error: null, status: 200 })).toEqual({ kind: "ok", data: { status: "ok" } });
  });

  it("only true network failures are transient", () => {
    expect(classifyResponse({ timedOut: true })).toMatchObject({ kind: "transient", reason: "timeout", maybeSent: true });
    expect(classifyResponse(fetchFailed)).toMatchObject({ kind: "transient", reason: "network" });
    expect(classifyResponse({ error: { message: "FetchError: request to … failed" }, status: 0 })).toMatchObject({ kind: "transient" });
    expect(classifyResponse({ error: { message: "AbortError: The operation was aborted" }, status: 0 })).toMatchObject({ kind: "transient" });
    // timedQuery turns a thrown builder into { error, status: 0 }.
    expect(classifyResponse({ error: new TypeError("Load failed"), status: 0 })).toMatchObject({ kind: "transient" });
  });

  it("401 / 403 / JWT errors are auth errors, not transient", () => {
    expect(classifyResponse(http(401))).toMatchObject({ kind: "error", category: "auth", status: 401 });
    expect(classifyResponse(http(403, { code: "42501" }))).toMatchObject({ kind: "error", category: "auth", status: 403 });
    expect(classifyResponse(http(400, { code: "PGRST301" }))).toMatchObject({ kind: "error", category: "auth" });
  });

  it("5xx, 408 and 429 are server errors", () => {
    for (const status of [500, 502, 503, 504, 408, 429]) {
      expect(classifyResponse(http(status))).toMatchObject({ kind: "error", category: "server", status });
    }
  });

  it("other 4xx are refusals with the database's details", () => {
    const res = classifyResponse(http(400, { message: "Marked a no-show", code: "P0001", hint: "no_show", details: "x" }));
    expect(res).toEqual({ kind: "error", category: "rejected", status: 400, code: "P0001", hint: "no_show", detail: "x", message: "Marked a no-show" });
    expect(classifyResponse(http(404, { code: "PGRST202" }))).toMatchObject({ category: "rejected", code: "PGRST202" });
  });
});

describe("httpCategory", () => {
  it("sorts statuses", () => {
    expect(httpCategory(401)).toBe("auth");
    expect(httpCategory(403)).toBe("auth");
    expect(httpCategory(500)).toBe("server");
    expect(httpCategory(409)).toBe("rejected");
    expect(httpCategory(400, "PGRST303")).toBe("auth");
  });
});

describe("classifySession", () => {
  it("a session is ok", () => {
    expect(classifySession({ data: { session: { access_token: "t" } }, error: null })).toMatchObject({ kind: "ok" });
  });

  it("no network to refresh the token is transient", () => {
    const error = { name: "AuthRetryableFetchError", message: "Failed to fetch", status: 0 };
    expect(classifySession({ data: { session: null }, error })).toMatchObject({ kind: "transient", reason: "network" });
    expect(classifySession({ thrown: new TypeError("Failed to fetch") })).toMatchObject({ kind: "transient" });
    expect(classifySession({ timedOut: true })).toMatchObject({ kind: "transient", reason: "timeout" });
    const lock = Object.assign(new Error("Acquiring an exclusive Navigator LockManager lock timed out"), { name: "NavigatorLockAcquireTimeoutError" });
    expect(classifySession({ thrown: lock })).toMatchObject({ kind: "transient", reason: "lock" });
  });

  it("the auth server answering 5xx is a server error", () => {
    const error = { name: "AuthRetryableFetchError", message: "Bad Gateway", status: 502 };
    expect(classifySession({ data: { session: null }, error })).toMatchObject({ kind: "error", category: "server", status: 502 });
  });

  it("signed out or refresh refused is an auth error", () => {
    expect(classifySession({ data: { session: null }, error: null })).toMatchObject({ kind: "error", category: "auth", status: 401 });
    const refused = { name: "AuthApiError", message: "Invalid Refresh Token: Refresh Token Not Found", status: 400 };
    expect(classifySession({ data: { session: null }, error: refused })).toMatchObject({ kind: "error", category: "auth" });
  });
});

describe("isRetryable", () => {
  it("reads may use the saved copy on no answer, server and auth errors", () => {
    expect(isRetryable(classifyResponse(fetchFailed))).toBe(true);
    expect(isRetryable(classifyResponse(http(503)))).toBe(true);
    expect(isRetryable(classifyResponse(http(401)))).toBe(true);
    expect(isRetryable(classifyResponse(http(400)))).toBe(false);
    expect(isRetryable({ kind: "ok", data: [] })).toBe(false);
  });
});

describe("describeFailure", () => {
  it("401: sign in again, not checked in", () => {
    const f = describeFailure(classifyResponse(http(401)));
    expect(f.title).toBe("Signed out — sign in again");
    expect(f.detail).toBe("Not checked in. Your sign-in expired. Sign in again.");
  });

  it("403 says the account isn't allowed", () => {
    expect(describeFailure(classifyResponse(http(403))).detail).toMatch(/HTTP 403/);
  });

  it("500: red, with the status and the paper-list fallback", () => {
    const f = describeFailure(classifyResponse(http(500)));
    expect(f.title).toBe("Not checked in");
    expect(f.detail).toBe("The server refused this (HTTP 500). Try again or use the paper list.");
    expect(describeFailure(classifyResponse(http(502)), { action: "Lunch not recorded" }).title).toBe("Lunch not recorded");
  });

  it("refusals keep the database's message", () => {
    const f = describeFailure(classifyResponse(http(400, { message: "Not authorized" })), { title: "Check-in failed" });
    expect(f).toEqual({ title: "Check-in failed", detail: "Not authorized" });
  });
});

describe("queueStep", () => {
  const item = (serverFailures = 0) => ({ op: "check_in", code: "DH27-H1", serverFailures });

  it("no answer: keep waiting", () => {
    expect(queueStep(classifyResponse(fetchFailed), item())).toEqual({ action: "wait", serverFailures: 0 });
    expect(queueStep(classifyResponse({ timedOut: true }), item(1))).toEqual({ action: "wait", serverFailures: 1 });
  });

  it("401 / 403: flag at once (never retried forever)", () => {
    expect(queueStep(classifyResponse(http(401)), item()).action).toBe("auth");
    expect(queueStep(classifyResponse(http(403)), item()).action).toBe("auth");
  });

  it("5xx: retried a few times, then flagged", () => {
    let it_ = item();
    const actions = [];
    for (let k = 0; k < SERVER_RETRY_LIMIT; k++) {
      const step = queueStep(classifyResponse(http(500)), it_);
      actions.push(step.action);
      it_ = { ...it_, serverFailures: step.serverFailures };
    }
    expect(actions).toEqual([...Array(SERVER_RETRY_LIMIT - 1).fill("wait"), "attention"]);
    expect(it_.serverFailures).toBe(SERVER_RETRY_LIMIT);
  });

  it("answers and refusals settle (outcomeFor decides)", () => {
    expect(queueStep({ kind: "ok", data: { status: "ok" } }, item()).action).toBe("settle");
    expect(queueStep(classifyResponse(http(400, { hint: "no_show" })), item()).action).toBe("settle");
  });
});

describe("attentionText", () => {
  it("says what to do for auth and server flags", () => {
    expect(attentionText({ op: "check_in" }, classifyResponse(http(401)))).toBe("Sign-in expired: sign in again, then tap Retry");
    expect(attentionText({ op: "check_in", serverFailures: 3 }, classifyResponse(http(500)))).toBe(
      "Server error (HTTP 500) 3 times: not synced. Tap Retry, or use the paper list"
    );
  });

  it("keeps the existing refusal texts", () => {
    expect(attentionText({ op: "check_in" }, { kind: "ok", data: { status: "unknown" } })).toBe("Not on the roster");
    expect(attentionText({ op: "check_in" }, classifyResponse(http(400, { hint: "no_show" })))).toMatch(/no-show/);
    expect(attentionText({ op: "scan" }, classifyResponse(http(404, { code: "PGRST202" })))).toMatch(/can't record meal/);
    const changed = attentionText({ op: "undo" }, classifyResponse(http(409, { hint: "checkin_changed", details: "2027-01-16T18:00:00Z" })), { formatTime: () => "10:00 AM" });
    expect(changed).toBe("Checked in again at 10:00 AM, so the undo wasn't applied");
  });
});
