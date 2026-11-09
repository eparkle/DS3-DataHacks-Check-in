// The offline queue against a fake Supabase: what gets retried, what gets
// flagged, and that a retry keeps its client id.
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => {
  globalThis.window = globalThis.window || { addEventListener() {} };
  return { answers: [], calls: [], session: { access_token: "t" } };
});

vi.mock("./supabase.js", () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: fake.session }, error: null }),
      refreshSession: async () => ({ data: {}, error: null }),
    },
    rpc: (name, args) => {
      fake.calls.push({ name, args });
      const next = fake.answers.shift() || { data: { status: "ok" }, error: null, status: 200 };
      return Promise.resolve(next);
    },
  },
}));

vi.mock("./offline-store.js", () => {
  const store = new Map();
  return {
    kvGet: async (k) => store.get(k),
    kvSet: async (k, v) => void store.set(k, JSON.parse(JSON.stringify(v))),
    kvDelete: async (k) => void store.delete(k),
    kvDeletePrefix: async (p) => [...store.keys()].forEach((k) => k.startsWith(p) && store.delete(k)),
  };
});

const { CheckinQueue } = await import("./offline.js");
const { SERVER_RETRY_LIMIT } = await import("./errors.js");

const fetchFailed = { data: null, error: { message: "TypeError: Failed to fetch", code: "", hint: "", details: "" }, status: 0 };
const http = (status) => ({ data: null, error: { message: `HTTP ${status}`, code: "", hint: "", details: "" }, status });

let users = 0;
async function newQueue(n = 1) {
  const q = new CheckinQueue();
  q.testUser = `user-${++users}`;
  await q.load(q.testUser);
  for (let k = 0; k < n; k++) await q.add({ op: "check_in", eventId: "ev", code: `DH27-H${k + 1}`, name: `P${k + 1}` });
  q.stop();
  q.settled = [];
  q.onSettled = (item, outcome) => q.settled.push([item.code, outcome]);
  return q;
}

beforeEach(() => {
  fake.answers = [];
  fake.calls = [];
  fake.session = { access_token: "t" };
});

describe("CheckinQueue.flush", () => {
  it("keeps an item waiting on a true network failure, and retries with the same client id", async () => {
    const q = await newQueue();
    const id = q.items[0].id;
    fake.answers.push(fetchFailed);
    await q.flush();
    q.stop();
    expect(q.pending).toHaveLength(1);
    expect(q.attention).toHaveLength(0);

    await q.flush();
    q.stop();
    expect(q.items).toHaveLength(0);
    expect(q.settled).toEqual([["DH27-H1", "synced"]]);
    expect(fake.calls.map((c) => c.args.p_client_id)).toEqual([id, id]);
  });

  it("flags every waiting item on a 401 instead of retrying forever", async () => {
    const q = await newQueue(2);
    fake.answers.push(http(401));
    await q.flush();
    expect(fake.calls).toHaveLength(1);
    expect(q.pending).toHaveLength(0);
    expect(q.attention.map((i) => i.blocked)).toEqual(["auth", "auth"]);
    expect(q.attention[0].error).toMatch(/sign in again/i);
    expect(q.settled).toEqual([
      ["DH27-H1", "attention"],
      ["DH27-H2", "attention"],
    ]);
    // Nothing scheduled: it doesn't keep trying.
    expect(q.timer).toBeNull();

    // A new sign-in (load) gives them another go.
    await q.load(q.testUser);
    expect(q.pending).toHaveLength(2);
    q.stop();
  });

  it("flags an item after a few server errors, then moves on", async () => {
    const q = await newQueue(2);
    for (let k = 0; k < SERVER_RETRY_LIMIT; k++) fake.answers.push(http(500));
    for (let k = 0; k < SERVER_RETRY_LIMIT; k++) {
      expect(q.attention).toHaveLength(0);
      await q.flush();
      q.stop();
    }
    const [first] = q.attention;
    expect(first.code).toBe("DH27-H1");
    expect(first.blocked).toBe("server");
    expect(first.error).toMatch(/HTTP 500/);
    // The next item went through on the same flush.
    expect(q.pending).toHaveLength(0);
    expect(q.settled).toEqual([
      ["DH27-H1", "attention"],
      ["DH27-H2", "synced"],
    ]);
  });

  it("an expired sign-in with no network to refresh it stays waiting", async () => {
    const q = await newQueue();
    fake.session = null;
    const { supabase } = await import("./supabase.js");
    const spy = vi.spyOn(supabase.auth, "getSession").mockResolvedValueOnce({
      data: { session: null },
      error: { name: "AuthRetryableFetchError", message: "Failed to fetch", status: 0 },
    });
    await q.flush();
    q.stop();
    expect(spy).toHaveBeenCalled();
    expect(q.pending).toHaveLength(1);
    expect(fake.calls).toHaveLength(0);
  });

  it("Retry puts a flagged item back with a fresh server-error count", async () => {
    const q = await newQueue();
    fake.answers.push(http(403));
    await q.flush();
    const id = q.attention[0].id;
    await q.retry(id);
    q.stop();
    // retry() flushes: the default answer is ok.
    await vi.waitFor(() => expect(q.items).toHaveLength(0));
  });
});
