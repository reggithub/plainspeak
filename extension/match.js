/* Plainspeak shared matching primitives.
 *
 * Loaded before content.js and editor.js, which share one isolated world, so
 * PS_MATCH is visible to both. This is the single source of truth for what
 * counts as a headline and how text is normalized; when the editor and the
 * matcher disagree, the editor produces annotations that silently never render.
 *
 * Offsets in annotations.json index the NORMALIZED string, not the raw DOM text.
 */

(function (root) {
  "use strict";

  const PUNCT = {
    "\u2018": "'", "\u2019": "'", "\u201A": "'", "\u201B": "'",
    "\u201C": '"', "\u201D": '"', "\u201E": '"', "\u201F": '"',
    "\u2013": "-", "\u2014": "-", "\u2212": "-",
    "\u00A0": " ", "\u2009": " ", "\u202F": " ", "\u200A": " "
  };

  // Folds smart punctuation to ASCII, collapses whitespace runs to one space,
  // and drops leading/trailing space. Idempotent.
  function normalize(raw) {
    const out = [];
    let pendingSpace = false;
    for (let i = 0; i < raw.length; i++) {
      let ch = raw[i];
      if (PUNCT[ch]) ch = PUNCT[ch];
      if (/\s/.test(ch)) { pendingSpace = out.length > 0; continue; }
      if (pendingSpace) { out.push(" "); pendingSpace = false; }
      out.push(ch);
    }
    return out.join("");
  }

  const key = (s) => normalize(s).toLowerCase();

  const SELECTOR = "h1, h2, h3, h4, p, span, a, div";
  const MAX_LEN = 400;
  const MAX_CHILDREN = 4;

  // Our own UI is full of headline-shaped text. Without this the matcher would
  // annotate the editor's own rows, and the editor would offer them as candidates.
  const OURS = "#ps-editor, #ps-badge";

  // Every element whose whole text could be a headline, deduped by normalized
  // key. Keeps the DEEPEST element per key: an ancestor may also "contain" the
  // headline, and rewriting that would destroy neighbouring content.
  function candidates(opts) {
    const o = Object.assign({ minWords: 3, skipAttr: null }, opts);
    const byKey = new Map();

    for (const el of document.querySelectorAll(SELECTOR)) {
      if (el.closest(OURS)) continue;
      if (o.skipAttr && el.closest("[" + o.skipAttr + "]")) continue;
      if (el.childElementCount > MAX_CHILDREN) continue;

      const txt = el.textContent;
      if (!txt || txt.length > MAX_LEN) continue;

      const text = normalize(txt);
      if (!text || text.split(" ").length < o.minWords) continue;

      const k = text.toLowerCase();
      const prev = byKey.get(k);
      if (!prev || prev.el.contains(el)) {
        byKey.set(k, { el, text, key: k, tag: el.tagName.toLowerCase() });
      }
    }
    return [...byKey.values()];
  }

  // The single deepest element matching one headline key, or null.
  function findTarget(headlineKey, skipAttr) {
    let best = null;
    for (const el of document.querySelectorAll(SELECTOR)) {
      if (el.closest(OURS)) continue;
      if (skipAttr && el.hasAttribute(skipAttr)) continue;
      if (el.childElementCount > MAX_CHILDREN) continue;

      const txt = el.textContent;
      if (!txt || txt.length > MAX_LEN) continue;
      if (key(txt) !== headlineKey) continue;

      if (!best || best.contains(el)) best = el;
    }
    return best;
  }

  root.PS_MATCH = { PUNCT, normalize, key, candidates, findTarget, SELECTOR };
})(typeof globalThis !== "undefined" ? globalThis : this);
