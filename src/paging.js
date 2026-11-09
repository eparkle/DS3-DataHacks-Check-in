// PostgREST answers at most 1,000 rows per request (Supabase's max-rows),
// whatever .range() asks for. Lists that can be longer are read a page at a
// time, ordered by a unique key so pages don't overlap or skip.
//
// Pure: fetchPage(from, to) does the request and resolves to timedQuery's
// shape ({ kind: "ok", data } | { kind: "transient" | "error", ... }).

export const PAGE_SIZE = 1000;

/**
 * Reads pages until one comes back shorter than pageSize. Resolves to
 * { kind: "ok", data: allRows } or the first failed page's result as is.
 * key(row): optional id; a row seen twice (rows added while paging shift the
 * later pages) is kept once.
 */
export async function fetchAllPages(fetchPage, { pageSize = PAGE_SIZE, maxPages = 200, key = null } = {}) {
  const rows = [];
  const seen = key ? new Set() : null;
  let last = null;
  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize;
    const res = await fetchPage(from, from + pageSize - 1);
    if (!res || res.kind !== "ok") return res;
    last = res;
    const data = Array.isArray(res.data) ? res.data : [];
    data.forEach((row) => {
      if (seen) {
        const k = key(row);
        if (k !== undefined && k !== null) {
          if (seen.has(k)) return;
          seen.add(k);
        }
      }
      rows.push(row);
    });
    if (data.length < pageSize) break;
  }
  return { ...last, kind: "ok", data: rows };
}
