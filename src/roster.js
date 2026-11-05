// Roster at scale: search, A–Z grouping and a virtualized list with an
// iOS-Contacts-style letter index. No framework; the list only ever renders
// the rows on screen (+ overscan), so 500+ people scroll smoothly on a phone.

// ---------- Text normalization ----------
const FOLD = { ø: "o", đ: "d", ł: "l", æ: "ae", œ: "oe", ß: "ss", ı: "i", þ: "th", ð: "d" };
const HONORIFIC = /^(dr|prof|mr|mrs|ms|mx|sir)\.?\s+/i;

// "Chloé Nguyen-Whitfield" -> "chloe nguyen whitfield"; "O'Brien" -> "obrien".
export function fold(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[øđłæœßıþð]/g, (c) => FOLD[c])
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

export const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true, ignorePunctuation: true });

// Name used for A–Z order: honorifics ("Dr.", "Prof.") don't decide the letter.
export function sortName(name) {
  return String(name || "").trim().replace(HONORIFIC, "");
}

// The index letter for a name: A–Z after folding accents, "#" for anything else.
export function letterOf(name) {
  const c = fold(sortName(name)).charAt(0).toUpperCase();
  return c >= "A" && c <= "Z" ? c : "#";
}

// Precomputed search fields for one person (built once per roster load).
export function searchIndex(p) {
  const name = fold(p.name);
  const stripped = fold(sortName(p.name));
  const code = String(p.code || "").toUpperCase();
  const short = code.replace(/^[^-]+-(?=.)/, "");
  const num = (short.match(/(\d+)$/) || [])[1] || "";
  const email = String(p.email || "").toLowerCase();
  const team = fold(p.team);
  return {
    name,
    stripped,
    nameWords: name.split(" ").filter(Boolean),
    otherWords: [...team.split(" "), ...fold(email.split("@")[0]).split(" ")].filter(Boolean),
    team,
    email,
    code,
    short,
    letters: short.replace(/\d+$/, ""),
    num: num ? String(Number(num)) : "",
    letter: letterOf(p.name),
    sortName: sortName(p.name),
  };
}

// Optimal string alignment distance, bailing out once it exceeds max.
function editDistance(a, b, max) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2 = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length];
}

// Typo tolerance for a name word: whole word or the same-length start of it.
function fuzzyWord(token, word) {
  if (token.length < 4) return Infinity;
  const max = token.length >= 7 ? 2 : 1;
  let best = editDistance(token, word, max);
  if (word.length > token.length) {
    best = Math.min(best, editDistance(token, word.slice(0, token.length), max), editDistance(token, word.slice(0, token.length + 1), max));
  }
  return best <= max ? best : Infinity;
}

// Score one person against a query. 0 = no match. Higher ranks first:
// exact code > name prefix > word prefix > fuzzy.
function score(s, q) {
  const { folded, tokens, upper, digits } = q;
  // Exact code: "DH27BETA-H042", "H042", "h42", "42".
  if (upper === s.code || upper === s.short) return 1000;
  if (digits && digits === s.num) return 1000;
  const lm = upper.match(/^([A-Z]+)0*(\d+)$/);
  if (lm && lm[1] === s.letters && String(Number(lm[2])) === s.num) return 1000;
  if (q.raw.includes("@") && s.email === q.raw) return 1000;

  // Whole-word hits rank above partial ones ("jon": Jon Castro before Jonah).
  const whole = tokens.filter((t) => s.nameWords.includes(t)).length;
  if (s.name.startsWith(folded) || s.stripped.startsWith(folded)) return 900 + Math.min(whole, 4) * 10;

  let tier = 700;
  let penalty = 0;
  for (const t of tokens) {
    if (s.nameWords.some((w) => w.startsWith(t))) continue;
    if (s.otherWords.some((w) => w.startsWith(t))) {
      tier = Math.min(tier, 500);
      continue;
    }
    let d = Infinity;
    for (const w of s.nameWords) d = Math.min(d, fuzzyWord(t, w));
    if (d !== Infinity) {
      tier = Math.min(tier, 300);
      penalty += d * 10;
      continue;
    }
    if (t.length >= 3 && (s.name.includes(t) || s.team.includes(t) || s.email.includes(t))) {
      tier = Math.min(tier, 200);
      continue;
    }
    tier = 0;
    break;
  }
  if (tier === 700) return 700 + Math.min(whole, 4) * 10;
  // A partial code ("H04", "DH27BETA-H0") ranks with word-prefix matches.
  const codeQuery = upper.replace(/\s+/g, "");
  if (codeQuery.length >= 2 && (s.short.startsWith(codeQuery) || s.code.startsWith(codeQuery))) return 600;
  if (digits && s.num.startsWith(digits)) return 600;
  if (q.raw.length >= 3 && s.email.startsWith(q.raw)) return 650;
  return tier ? tier - penalty : 0;
}

export function parseQuery(raw) {
  const trimmed = String(raw || "").trim();
  const folded = fold(trimmed);
  return {
    raw: trimmed.toLowerCase(),
    folded,
    tokens: folded.split(" ").filter(Boolean),
    upper: trimmed.toUpperCase(),
    digits: /^\d+$/.test(trimmed) ? String(Number(trimmed)) : "",
  };
}

// Ranked matches across everyone in the tab (filters don't apply to search).
export function searchPeople(people, raw) {
  const q = parseQuery(raw);
  if (!q.folded && !q.digits && !q.upper) return [];
  const hits = [];
  for (const p of people) {
    const sc = score(p.search, q);
    if (sc > 0) hits.push([sc, p]);
  }
  hits.sort((a, b) => b[0] - a[0] || collator.compare(a[1].search.sortName, b[1].search.sortName) || a[1].code.localeCompare(b[1].code));
  return hits.map((h) => h[1]);
}

export function compareAZ(a, b) {
  const la = a.search.letter, lb = b.search.letter;
  if (la !== lb) return la === "#" ? 1 : lb === "#" ? -1 : la < lb ? -1 : 1;
  return collator.compare(a.search.sortName, b.search.sortName) || a.code.localeCompare(b.code);
}

export function compareNewestIn(a, b) {
  return (Date.parse(b.checked_in_at || 0) || 0) - (Date.parse(a.checked_in_at || 0) || 0) || compareAZ(a, b);
}

export const LETTERS = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ", "#"];

// ---------- Virtual list ----------
// items: [{ key, type: "head" | "row", letter?, person? }]. Row heights come
// from CSS custom properties so a stylesheet tweak can't desync the math.
export class VirtualList {
  constructor({ scroller, sizer, sticky, renderRow, renderHead, rowSignature, overscan = 8 }) {
    this.scroller = scroller;
    this.sizer = sizer;
    this.sticky = sticky;
    this.renderRow = renderRow;
    this.renderHead = renderHead;
    this.rowSignature = rowSignature;
    this.overscan = overscan;
    this.items = [];
    this.tops = [];
    this.heights = [];
    this.total = 0;
    this.nodes = new Map(); // key -> { el, sig }
    this.pool = [];
    this.headIdx = []; // indexes of header items, in order
    this.grouped = false;
    this.frame = 0;
    this.metrics = null;
    this.onScrollExtra = null;
    scroller.addEventListener("scroll", () => this.schedule(), { passive: true });
    new ResizeObserver(() => {
      this.metrics = null;
      if (this.items.length) this.layout();
      this.schedule();
    }).observe(scroller);
  }

  readMetrics() {
    if (this.metrics) return this.metrics;
    const cs = getComputedStyle(this.scroller);
    const px = (name, fallback) => parseFloat(cs.getPropertyValue(name)) || fallback;
    this.metrics = { row: px("--row-h", 60), gap: px("--row-gap", 6), head: px("--head-h", 28), headGap: px("--head-gap", 6), pad: px("--list-pad-bottom", 28) };
    return this.metrics;
  }

  layout() {
    const m = this.readMetrics();
    let y = 0;
    this.tops = new Array(this.items.length);
    this.heights = new Array(this.items.length);
    this.headIdx = [];
    this.items.forEach((it, i) => {
      const h = it.type === "head" ? m.head : m.row;
      this.tops[i] = y;
      this.heights[i] = h;
      if (it.type === "head") this.headIdx.push(i);
      y += h + (it.type === "head" ? m.headGap : m.gap);
    });
    this.total = this.items.length ? y - m.gap + m.pad : 0;
    this.sizer.style.height = `${this.total}px`;
  }

  // First item whose bottom is below y.
  indexAt(y) {
    let lo = 0, hi = this.items.length - 1, ans = this.items.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.tops[mid] + this.heights[mid] > y) { ans = mid; hi = mid - 1; } else lo = mid + 1;
    }
    return ans;
  }

  // Replace the items. With keepAnchor, the first row on screen stays where it
  // is (realtime updates from other desks never jump the list).
  setItems(items, { keepAnchor = true, animate = false, grouped = false, resetScroll = false } = {}) {
    let anchor = null;
    if (keepAnchor && !resetScroll && this.items.length) {
      const st = this.scroller.scrollTop;
      const start = this.indexAt(st);
      for (let i = start; i < this.items.length && this.tops[i] < st + this.scroller.clientHeight; i++) {
        anchor = anchor || [];
        anchor.push({ key: this.items[i].key, offset: this.tops[i] - st });
      }
    }
    this.items = items;
    this.grouped = grouped;
    this.keyIndex = new Map(items.map((it, i) => [it.key, i]));
    this.layout();
    if (resetScroll) this.scroller.scrollTop = 0;
    else if (anchor) {
      const hit = anchor.find((a) => this.keyIndex.has(a.key));
      if (hit) {
        const target = this.tops[this.keyIndex.get(hit.key)] - hit.offset;
        const max = Math.max(0, this.total - this.scroller.clientHeight);
        const next = Math.max(0, Math.min(max, target));
        if (Math.abs(next - this.scroller.scrollTop) > 0.5) this.scroller.scrollTop = next;
      }
    }
    this.scroller.classList.toggle("animating", animate);
    if (animate) {
      clearTimeout(this.animTimer);
      this.animTimer = setTimeout(() => this.scroller.classList.remove("animating"), 320);
    }
    this.render();
  }

  // Re-render rows whose data changed, without touching positions.
  refresh() {
    this.render(true);
  }

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.render();
    });
  }

  scrollToKey(key) {
    const i = this.keyIndex?.get(key);
    if (i == null) return;
    const max = Math.max(0, this.total - this.scroller.clientHeight);
    this.scroller.scrollTop = Math.min(max, this.tops[i]);
    this.render();
  }

  // The section (letter) at the top of the viewport.
  currentHead() {
    if (!this.grouped || !this.headIdx.length) return null;
    const st = this.scroller.scrollTop;
    let lo = 0, hi = this.headIdx.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.tops[this.headIdx[mid]] <= st + 0.5) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  render(force = false) {
    const st = this.scroller.scrollTop;
    const vh = this.scroller.clientHeight || 600;
    const first = Math.max(0, this.indexAt(st) - this.overscan);
    let last = first;
    while (last < this.items.length && this.tops[last] < st + vh) last++;
    last = Math.min(this.items.length, last + this.overscan);

    const animating = this.scroller.classList.contains("animating");
    const fresh = [];
    const want = new Set();
    for (let i = first; i < last; i++) want.add(this.items[i].key);
    for (const [key, node] of this.nodes) {
      if (!want.has(key)) {
        node.el.remove();
        this.nodes.delete(key);
        if (this.pool.length < 40) this.pool.push(node.el);
      }
    }
    for (let i = first; i < last; i++) {
      const it = this.items[i];
      let node = this.nodes.get(it.key);
      const sig = it.type === "head" ? `h${it.letter}` : this.rowSignature(it);
      const isNew = !node;
      if (!node) {
        const el = this.pool.pop() || document.createElement("div");
        node = { el, sig: null, y: null };
        this.nodes.set(it.key, node);
      }
      if (node.sig !== sig || force) {
        if (it.type === "head") this.renderHead(node.el, it);
        else this.renderRow(node.el, it, i);
        node.sig = sig;
      }
      const y = this.tops[i];
      if (node.y !== y) {
        node.el.style.transform = `translateY(${y}px)`;
        node.y = y;
      }
      if (isNew) {
        // New rows appear in place; only rows already on screen slide.
        if (animating) {
          node.el.classList.add("fresh");
          fresh.push(node.el);
        }
        this.sizer.appendChild(node.el);
      }
    }
    if (fresh.length) requestAnimationFrame(() => requestAnimationFrame(() => fresh.forEach((el) => el.classList.remove("fresh"))));
    this.renderSticky(st);
    if (this.onScrollExtra) this.onScrollExtra();
  }

  // The pinned letter at the top; the next section header pushes it up.
  renderSticky(st) {
    if (!this.sticky) return;
    const h = this.currentHead();
    if (h == null) {
      this.sticky.hidden = true;
      return;
    }
    const m = this.readMetrics();
    const it = this.items[this.headIdx[h]];
    const nextTop = h + 1 < this.headIdx.length ? this.tops[this.headIdx[h + 1]] : Infinity;
    const shift = Math.min(0, nextTop - st - m.head - m.headGap);
    this.sticky.hidden = false;
    if (this.sticky.dataset.letter !== it.letter) {
      this.sticky.dataset.letter = it.letter;
      this.sticky.innerHTML = `<span>${it.letter}</span>`;
    }
    this.sticky.style.transform = `translateY(${shift}px)`;
  }

  get domRows() {
    return this.nodes.size;
  }
}

// ---------- A–Z index (right edge) ----------
// Touch-drag or click to jump. Letters with nobody under them are dimmed and
// skipped (the drag lands on the nearest letter that exists).
export class LetterIndex {
  constructor({ root, bubble, onJump }) {
    this.root = root;
    this.bubble = bubble;
    this.onJump = onJump;
    this.active = new Set();
    this.dragging = false;
    this.last = null;
    root.innerHTML = LETTERS.map(
      (l) => `<button type="button" class="az-l" data-letter="${l}" tabindex="-1" aria-label="Jump to ${l === "#" ? "other names" : l}">${l}</button>`
    ).join("");
    this.buttons = [...root.querySelectorAll(".az-l")];

    root.addEventListener("pointerdown", (e) => {
      if (e.button > 0) return;
      e.preventDefault();
      this.dragging = true;
      this.last = null;
      try { root.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      root.classList.add("dragging");
      this.pick(e.clientY);
    });
    root.addEventListener("pointermove", (e) => {
      if (this.dragging) this.pick(e.clientY);
    });
    const end = () => {
      if (!this.dragging) return;
      this.dragging = false;
      root.classList.remove("dragging");
      this.bubble.classList.remove("show");
    };
    root.addEventListener("pointerup", end);
    root.addEventListener("pointercancel", end);
    root.addEventListener("lostpointercapture", end);
    // Keyboard / assistive tech: a real click with no pointer drag.
    root.addEventListener("click", (e) => {
      const b = e.target.closest(".az-l");
      if (b && e.detail === 0 && this.active.has(b.dataset.letter)) this.onJump(b.dataset.letter);
    });
  }

  setLetters(letters) {
    this.active = new Set(letters);
    this.buttons.forEach((b) => {
      const on = this.active.has(b.dataset.letter);
      b.classList.toggle("off", !on);
      b.disabled = !on;
      b.tabIndex = on ? 0 : -1;
    });
  }

  setCurrent(letter) {
    if (this.current === letter) return;
    this.current = letter;
    this.buttons.forEach((b) => b.classList.toggle("cur", b.dataset.letter === letter));
  }

  nearest(i) {
    for (let d = 0; d < LETTERS.length; d++) {
      if (i + d < LETTERS.length && this.active.has(LETTERS[i + d])) return LETTERS[i + d];
      if (i - d >= 0 && this.active.has(LETTERS[i - d])) return LETTERS[i - d];
    }
    return null;
  }

  pick(clientY) {
    const r = this.root.getBoundingClientRect();
    const first = this.buttons[0].getBoundingClientRect();
    const lastB = this.buttons[this.buttons.length - 1].getBoundingClientRect();
    const span = lastB.bottom - first.top || r.height;
    const i = Math.max(0, Math.min(LETTERS.length - 1, Math.floor(((clientY - first.top) / span) * LETTERS.length)));
    const letter = this.nearest(i);
    if (!letter) return;
    // Bubble follows the finger, clamped inside the index.
    const base = (this.bubble.offsetParent || this.root).getBoundingClientRect().top;
    const y = Math.max(r.top + 28, Math.min(r.bottom - 28, clientY)) - base;
    this.bubble.style.transform = `translateY(${y}px)`;
    this.bubble.textContent = letter;
    this.bubble.classList.add("show");
    if (letter !== this.last) {
      this.last = letter;
      if (navigator.vibrate) try { navigator.vibrate(4); } catch { /* ignore */ }
      this.onJump(letter);
    }
  }
}
