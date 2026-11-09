import { describe, expect, it } from "vitest";
import { fetchAllPages } from "./paging.js";

// A fake table behind a PostgREST-like cap: whatever range is asked for,
// at most `cap` rows come back.
function fakeTable(n, { cap = 1000, failOnPage = -1, failure = { kind: "transient", reason: "network" } } = {}) {
  const rows = Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
  const calls = [];
  const fetchPage = async (from, to) => {
    calls.push([from, to]);
    if (calls.length - 1 === failOnPage) return failure;
    return { kind: "ok", data: rows.slice(from, Math.min(to + 1, from + cap)) };
  };
  return { fetchPage, calls };
}

describe("fetchAllPages", () => {
  it("reads past 1,000 rows in pages of 1,000", async () => {
    const { fetchPage, calls } = fakeTable(2500);
    const res = await fetchAllPages(fetchPage);
    expect(res.kind).toBe("ok");
    expect(res.data).toHaveLength(2500);
    expect(res.data.at(-1)).toEqual({ id: 2500 });
    expect(calls).toEqual([
      [0, 999],
      [1000, 1999],
      [2000, 2999],
    ]);
  });

  it("stops after one request for a short first page", async () => {
    const { fetchPage, calls } = fakeTable(12);
    const res = await fetchAllPages(fetchPage);
    expect(res.data).toHaveLength(12);
    expect(calls).toHaveLength(1);
  });

  it("asks once more when the last page is exactly full", async () => {
    const { fetchPage, calls } = fakeTable(2000);
    const res = await fetchAllPages(fetchPage);
    expect(res.data).toHaveLength(2000);
    expect(calls).toHaveLength(3);
  });

  it("handles an empty table", async () => {
    const { fetchPage } = fakeTable(0);
    const res = await fetchAllPages(fetchPage);
    expect(res).toMatchObject({ kind: "ok", data: [] });
  });

  it("returns the first failed page's result as is", async () => {
    const failure = { kind: "error", category: "server", status: 500, message: "boom" };
    const { fetchPage } = fakeTable(2500, { failOnPage: 1, failure });
    const res = await fetchAllPages(fetchPage);
    expect(res).toBe(failure);
  });

  it("keeps a row seen on two pages once when given a key", async () => {
    let call = 0;
    const fetchPage = async () => {
      call += 1;
      // Page 2 starts with the last row of page 1 (a row was added meanwhile).
      if (call === 1) return { kind: "ok", data: [{ id: 1 }, { id: 2 }] };
      return { kind: "ok", data: [{ id: 2 }] };
    };
    const res = await fetchAllPages(fetchPage, { pageSize: 2, key: (r) => r.id });
    expect(res.data).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("stops at maxPages", async () => {
    const fetchPage = async (from, to) => ({ kind: "ok", data: Array.from({ length: to - from + 1 }, (_, i) => ({ id: from + i })) });
    const res = await fetchAllPages(fetchPage, { pageSize: 10, maxPages: 3 });
    expect(res.data).toHaveLength(30);
  });
});
