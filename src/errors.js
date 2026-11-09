// How a Supabase answer (or the lack of one) is sorted, and what the desk says
// about it. Pure (no supabase, no DOM), so it's unit-tested.
//
// The one rule the desk depends on: only a TRUE network failure may be saved
// on the phone and shown as "Saved on phone · will sync":
//   - offline (navigator.onLine false), a ~6 s timeout, or fetch threw
//     (supabase-js gives status 0 and "TypeError: Failed to fetch",
//     "FetchError: …", "AbortError: …"): no HTTP answer came back.
// Anything with an HTTP status is a real answer from the server and is never
// queued:
//   - 401 / JWT errors / 403 / no session    category "auth"     (sign in again)
//   - 5xx, 408, 429                          category "server"   (red card; the queue retries a few times)
//   - any other 4xx                          category "rejected" (the database's own message)

export const JWT_CODES = new Set(["PGRST301", "PGRST302", "PGRST303"]);

// A queued item that keeps getting a server error is flagged after this many tries.
export const SERVER_RETRY_LIMIT = 3;

const NETWORK_NAMES = new Set(["TypeError", "FetchError", "AbortError", "TimeoutError", "AuthRetryableFetchError"]);
const NETWORK_TEXT = /failed to fetch|fetcherror|networkerror|network request failed|load failed|aborterror|timed? ?out|err_network|err_internet_disconnected/i;

/** An error thrown by fetch (or reported by supabase-js for one), not an HTTP answer. */
export function looksLikeNetworkError(error) {
  if (!error) return false;
  if (NETWORK_NAMES.has(error.name)) return true;
  return NETWORK_TEXT.test(String(error.message || error));
}

/** Which kind of HTTP answer this is. */
export function httpCategory(status, code = "") {
  if (status === 401 || status === 403 || JWT_CODES.has(code)) return "auth";
  if (status >= 500 || status === 408 || status === 429) return "server";
  return "rejected";
}

/**
 * A PostgREST result ({ data, error, status }) or { timedOut: true } to:
 *   { kind: "ok", data }
 *   { kind: "transient", reason: "timeout" | "network", maybeSent, message }   (no HTTP answer)
 *   { kind: "error", category, status, code, hint, detail, message }           (an HTTP answer)
 */
export function classifyResponse(res, { sent = true } = {}) {
  if (res?.timedOut) return { kind: "transient", reason: "timeout", maybeSent: sent, message: "Timed out" };
  const { data, error, status } = res || {};
  if (!error) return { kind: "ok", data };
  const message = error.message || String(error);
  if (!status) {
    // fetch threw / was aborted: never got an HTTP answer.
    return { kind: "transient", reason: "network", maybeSent: sent, message };
  }
  const code = error.code || "";
  return {
    kind: "error",
    category: httpCategory(status, code),
    message,
    status,
    code,
    hint: error.hint || "",
    detail: error.details || error.detail || "",
  };
}

const SIGNED_OUT = { kind: "error", category: "auth", status: 401, code: "no_session", hint: "", detail: "", message: "Your sign-in expired. Sign in again." };

/**
 * supabase.auth.getSession()'s answer ({ data: { session }, error }), what it
 * threw ({ thrown }), or { timedOut: true }, before a write:
 *   { kind: "ok", data: session } | transient (couldn't reach Supabase to
 *   refresh the token) | error "auth" (signed out / refresh refused) | error "server".
 */
export function classifySession(res) {
  if (res?.timedOut) return { kind: "transient", reason: "timeout", maybeSent: false, message: "Timed out" };
  if (res?.data?.session) return { kind: "ok", data: res.data.session };
  const error = res?.error || res?.thrown || null;
  // supabase-js couldn't take its storage lock in time (another tab): no
  // request went out and nothing is known about the sign-in; try again later.
  if (res?.thrown && /lock/i.test(`${res.thrown.name || ""} ${res.thrown.message || ""}`)) {
    return { kind: "transient", reason: "lock", maybeSent: false, message: res.thrown.message || "Sign-in storage is busy" };
  }
  if (error && looksLikeNetworkError(error)) {
    const status = Number(error.status) || 0;
    if (status >= 500) return { kind: "error", category: "server", status, code: "", hint: "", detail: "", message: error.message || `HTTP ${status}` };
    return { kind: "transient", reason: "network", maybeSent: false, message: error.message || "Couldn't reach Supabase to refresh the sign-in" };
  }
  return SIGNED_OUT;
}

/** Read paths may fall back to what's saved on the phone; writes may not. */
export function isRetryable(res) {
  return res?.kind === "transient" || (res?.kind === "error" && (res.category === "server" || res.category === "auth"));
}

/**
 * The red card for a write that didn't happen.
 * action: what didn't happen ("Not checked in"); title: the usual title for a
 * database refusal ("Check-in failed").
 */
export function describeFailure(result, { action = "Not checked in", title = "Check-in failed" } = {}) {
  if (result?.kind === "error" && result.category === "auth") {
    if (result.status === 403) {
      return { title: "Signed out — sign in again", detail: `${action}. This account isn't allowed to do this (HTTP 403). Sign in again as an organizer.` };
    }
    return { title: "Signed out — sign in again", detail: `${action}. Your sign-in expired. Sign in again.` };
  }
  if (result?.kind === "error" && result.category === "server") {
    return { title: action, detail: `The server refused this (HTTP ${result.status}). Try again or use the paper list.` };
  }
  return { title, detail: result?.message || "Something went wrong." };
}

// PostgREST couldn't find a function with these parameters (or the table):
// the database is older than this app.
export function isMissingApi(res) {
  return res?.kind === "error" && (res.code === "PGRST202" || res.code === "PGRST205" || res.code === "42P01" || res.code === "42883" || res.status === 404);
}

/**
 * What the queue does with the answer to a saved item:
 *   "wait"      keep it waiting, try again later (no answer, or a server error under the limit)
 *   "auth"      the sign-in is gone: flag it (and everything waiting) for attention, stop
 *   "attention" a server error too many times: flag it
 *   "settle"    a real answer: ok / already / refused (outcomeFor decides)
 * serverFailures: the item's count of server errors including this one.
 */
export function queueStep(result, item, limit = SERVER_RETRY_LIMIT) {
  const before = item?.serverFailures || 0;
  if (result?.kind === "transient") return { action: "wait", serverFailures: before };
  if (result?.kind === "error" && result.category === "auth") return { action: "auth", serverFailures: before };
  if (result?.kind === "error" && result.category === "server") {
    const serverFailures = before + 1;
    return { action: serverFailures >= limit ? "attention" : "wait", serverFailures };
  }
  return { action: "settle", serverFailures: before };
}

// What the sync sheet says about an item the server wouldn't take.
export function attentionText(item, result, { formatTime = defaultTime } = {}) {
  if (result.kind === "error") {
    if (result.category === "auth") {
      return result.status === 403
        ? "Not allowed (HTTP 403): sign in again as an organizer, then tap Retry"
        : "Sign-in expired: sign in again, then tap Retry";
    }
    if (result.category === "server") {
      const n = item?.serverFailures || 1;
      return `Server error (HTTP ${result.status})${n > 1 ? ` ${n} times` : ""}: not synced. Tap Retry, or use the paper list`;
    }
    if (result.hint === "checkin_changed") {
      const at = result.detail ? new Date(result.detail) : null;
      const when = at && !Number.isNaN(at.getTime()) ? ` at ${formatTime(at)}` : "";
      return `Checked in again${when}, so the undo wasn't applied`;
    }
    if (result.hint === "no_show") return "Marked a no-show: look them up online to let them in";
    if (item.op === "scan" && isMissingApi(result)) return "This database can't record meal or swag scans yet";
    return result.message;
  }
  const status = result.data?.status;
  if (status === "unknown" || status === "not_on_roster") return "Not on the roster";
  return `Unexpected answer: ${JSON.stringify(result.data)}`;
}

function defaultTime(d) {
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}
