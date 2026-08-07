/* Plainspeak diff -> ops.
 *
 * Turns "here is the headline, here is how I would have written it" into the
 * ops array annotations.json wants: strikes over what the publisher wrote,
 * inserts for what replaces it.
 *
 * Both strings must already be normalized (PS_MATCH.normalize), because op
 * offsets index the normalized string -- that is what content.js applyOps walks.
 *
 * Strategy: word-level LCS to find stable anchors, then a character-level
 * prefix/suffix trim inside each changed run. The trim is what keeps
 * "...Congressman Go" -> "...Congressman Go? Look at..." as a bare insert at the
 * end instead of striking "Go" and retyping it.
 *
 * Loadable as a content script (sets PS_DIFF) or via require() for tests.
 */

(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PS_DIFF = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // normalize() guarantees single spaces and no leading/trailing space, so a
  // plain split is enough and start offsets are exact.
  function words(s) {
    const out = [];
    let i = 0;
    if (!s) return out;
    for (const w of s.split(" ")) {
      out.push({ text: w, start: i });
      i += w.length + 1;
    }
    return out;
  }

  function buildOps(original, edited) {
    const O = original, E = edited;
    if (O === E) return [];

    const A = words(O), B = words(E);
    const n = A.length, m = B.length;

    // Longest common subsequence over words, computed backwards so the walk
    // below can go forwards and keep offsets ascending.
    const dp = [];
    for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = A[i].text === B[j].text
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }

    const ops = [];
    let oPos = 0, ePos = 0; // char cursors: end of the last word that matched

    // Emit ops for one changed run. The spans handed in INCLUDE the whitespace
    // around the changed words, so the trim can settle spacing on its own.
    function flush(oEnd, eEnd) {
      let ds = oPos, de = oEnd;
      let del = O.slice(ds, de);
      let ins = E.slice(ePos, eEnd);
      if (!del && !ins) return;

      let p = 0;
      while (p < del.length && p < ins.length && del[p] === ins[p]) p++;
      let s = 0;
      while (s < del.length - p && s < ins.length - p &&
             del[del.length - 1 - s] === ins[ins.length - 1 - s]) s++;

      // Pull the trim back to a word boundary. "Targets" -> "Tries" shares a
      // leading "T", and trimming it would strike "argets" and leave a widowed
      // "T". Exception: if the trim swallows the whole span there is no strike
      // left to widow, which is what turns "Go" -> "Go? Look..." into a bare
      // insert instead of striking "Go" and retyping it.
      if (p < del.length) { while (p > 0 && del[p - 1] !== " ") p--; }
      if (s < del.length - p) { while (s > 0 && del[del.length - s] !== " ") s--; }

      ds += p;
      de -= s;
      ins = ins.slice(p, ins.length - s);

      // Struck text stays visible, so a strike followed immediately by an insert
      // reads "wordTHEIRS" unless the strike swallows the trailing space too.
      if (de > ds && ins && O[de] === " ") { de += 1; ins += " "; }

      if (de > ds) ops.push({ t: "strike", start: ds, len: de - ds });
      if (ins) ops.push({ t: "insert", at: de, text: ins });
    }

    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i].text === B[j].text) {
        flush(A[i].start, B[j].start);
        oPos = A[i].start + A[i].text.length;
        ePos = B[j].start + B[j].text.length;
        i++; j++;
        continue;
      }
      if (dp[i + 1][j] >= dp[i][j + 1]) i++; else j++;
    }
    flush(O.length, E.length);

    return ops;
  }

  // What a reader takes away: kept text plus insertions, skipping struck words.
  // Used to prove the generated ops actually say what the editor typed.
  function readThrough(original, ops) {
    const asc = [...ops].sort((a, b) =>
      (a.t === "strike" ? a.start : a.at) - (b.t === "strike" ? b.start : b.at));

    let out = "", cursor = 0;
    for (const op of asc) {
      const pos = op.t === "strike" ? op.start : op.at;
      if (pos > cursor) { out += original.slice(cursor, pos); cursor = pos; }
      if (op.t === "strike") cursor = pos + op.len;
      else out += op.text;
    }
    return out + original.slice(cursor);
  }

  // The pieces content.js applyOps would build, for previewing.
  function pieces(original, ops) {
    const asc = [...ops].sort((a, b) =>
      (a.t === "strike" ? a.start : a.at) - (b.t === "strike" ? b.start : b.at));

    const out = [];
    let cursor = 0;
    for (const op of asc) {
      const pos = op.t === "strike" ? op.start : op.at;
      if (pos > cursor) { out.push({ type: "keep", text: original.slice(cursor, pos) }); cursor = pos; }
      if (op.t === "strike") {
        out.push({ type: "strike", text: original.slice(pos, pos + op.len) });
        cursor = pos + op.len;
      } else {
        out.push({ type: "insert", text: op.text });
      }
    }
    if (cursor < original.length) out.push({ type: "keep", text: original.slice(cursor) });
    return out;
  }

  return { buildOps, readThrough, pieces, words };
});
