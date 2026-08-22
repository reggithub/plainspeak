/* Plainspeak op application.
 *
 * Turns an annotation's ops into DOM edits on a live element. This used to live
 * in content.js and worked by rebuilding the element -- `el.textContent = ""`
 * followed by a flat fragment of text and annotation spans. That is why
 * safeToRewrite refused any element with a block child: flattening a card
 * collapsed its kicker, headline and badge onto one line and mangled the page.
 *
 * The cost of that rule was the front page's biggest headlines, which are
 * wrapped several elements deep and often broken across lines with a <br> or a
 * <div> per line. Refusing every block put them permanently out of reach.
 *
 * So nothing is rebuilt any more. Each op is resolved to a position in the
 * existing text nodes and applied by splitting them, which leaves every
 * element, class and line break exactly where the publisher put it. Blocks
 * inside are no longer a problem, and the publisher's own typography -- curly
 * quotes, em dashes -- survives, where the rebuild wrote back normalized ASCII.
 *
 * Op offsets index the NORMALIZED string (PS_MATCH.normalize). The live text is
 * raw. normalizeMap carries the correspondence between the two.
 *
 * Loadable as a content script (sets PS_APPLY) or via require() for tests.
 */

(function (root, factory) {
  "use strict";
  const isNode = typeof module === "object" && module.exports;
  const api = factory(isNode ? require("./match.js") : root.PS_MATCH);
  if (isNode) module.exports = api;
  else root.PS_APPLY = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (M) {
  "use strict";

  // Inserts opening with punctuation sit tight against the word before them;
  // see the .ps-tight note in annotate.css.
  const TIGHT = /^[,.;:!?)\]]/;

  // Every op must be in bounds before any of them is applied. A stale
  // annotation renders nothing -- half of one, applied to a headline that has
  // since been reworded, is worse than none at all.
  function opsFit(ops, len) {
    for (const op of ops) {
      const pos = op.t === "strike" ? op.start : op.at;
      if (typeof pos !== "number" || pos < 0 || pos > len) return false;
      if (op.t === "strike") {
        if (typeof op.len !== "number" || op.len < 0 || pos + op.len > len) return false;
      } else if (op.t !== "insert" || typeof op.text !== "string") {
        return false;
      }
    }
    return true;
  }

  // Applies ops to el's text nodes. Returns true if it rendered, false if the
  // ops do not fit the element's current text. Never removes publisher text:
  // a strike is a wrapper, not a deletion.
  function applyOps(el, ops, doc) {
    const flat = M.flattenText(el);
    const map = M.normalizeMap(flat.raw);
    const nText = map.text;

    if (!opsFit(ops, nText.length)) return false;

    // ---- normalized offset -> raw offset -> live text node

    const rawAt = (n) => (n < map.src.length ? map.src[n] : flat.raw.length);

    // A block boundary contributes a synthetic space with no node behind it, so
    // an op landing on one walks to the nearest real character: forward first,
    // since an insert belongs before the text it introduces.
    function anchor(r) {
      for (let i = r; i < flat.nodes.length; i++) {
        if (flat.nodes[i]) return { node: flat.nodes[i], offset: flat.offsets[i] };
      }
      for (let i = Math.min(r, flat.nodes.length) - 1; i >= 0; i--) {
        if (flat.nodes[i]) return { node: flat.nodes[i], offset: flat.offsets[i] + 1 };
      }
      return null;
    }

    // A strike can span several text nodes and, now, several blocks. One
    // wrapper per node keeps the rule continuous without moving any text across
    // an element boundary.
    function runs(rStart, rEnd) {
      const out = [];
      let cur = null;
      for (let i = rStart; i < rEnd && i < flat.nodes.length; i++) {
        const node = flat.nodes[i];
        if (!node) { cur = null; continue; }
        const off = flat.offsets[i];
        if (cur && cur.node === node && cur.end === off) { cur.end = off + 1; continue; }
        cur = { node, start: off, end: off + 1 };
        out.push(cur);
      }
      return out;
    }

    function span(cls, text, label) {
      const s = doc.createElement("span");
      s.className = cls;
      if (text) s.textContent = text;
      s.setAttribute("aria-label", label);
      return s;
    }

    // ---- plan against the pre-edit index, apply back to front
    //
    // splitText leaves the original node object holding everything BEFORE the
    // split, so any position earlier in that same node stays valid afterwards.
    // Descending order is what makes that hold for the whole batch, and it is
    // why every offset below is read from the index built at the top.
    const plan = [...ops].sort((a, b) => {
      const pa = a.t === "strike" ? a.start : a.at;
      const pb = b.t === "strike" ? b.start : b.at;
      return pb - pa;
    });

    for (const op of plan) {
      if (op.t === "strike") {
        if (!op.len) continue;
        const rStart = rawAt(op.start);
        let rEnd = rawAt(op.start + op.len - 1) + 1;

        // The last struck character may be a space that normalize() collapsed
        // out of a longer run. Cover the rest of the run so the rule does not
        // stop short of the gap it is meant to cross.
        const nextRaw = op.start + op.len < nText.length
          ? rawAt(op.start + op.len)
          : flat.raw.length;
        while (rEnd < nextRaw && /\s/.test(flat.raw[rEnd])) rEnd++;

        const label = "struck by Plainspeak: " + nText.slice(op.start, op.start + op.len);
        const parts = runs(rStart, rEnd);
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i];
          const first = p.start > 0 ? p.node.splitText(p.start) : p.node;
          if (p.end - p.start < first.nodeValue.length) first.splitText(p.end - p.start);
          const s = span("ps-del", "", label);
          first.parentNode.insertBefore(s, first);
          s.appendChild(first);
        }
      } else {
        const a = anchor(rawAt(op.at));
        if (!a) continue;

        const s = span("ps-ins" + (TIGHT.test(op.text) ? " ps-tight" : ""),
                       op.text, "Plainspeak annotation: " + op.text);

        const { node, offset } = a;
        if (offset <= 0) node.parentNode.insertBefore(s, node);
        else if (offset >= node.nodeValue.length) node.parentNode.insertBefore(s, node.nextSibling);
        else { const tail = node.splitText(offset); tail.parentNode.insertBefore(s, tail); }
      }
    }

    return true;
  }

  return { applyOps, opsFit };
});
