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

  // NYT article URLs carry a date path: /2026/08/07/us/politics/....
  const ARTICLE_HREF = /\/\d{4}\/\d{2}\/\d{2}\//;

  // Which article a run of text belongs to, if any. The link may wrap the text
  // itself, or wrap the whole card the text sits inside, so walk up a little.
  function articleHref(el) {
    let n = el;
    for (let hops = 0; n && hops < 4; hops++, n = n.parentElement) {
      if (n.tagName === "A" && ARTICLE_HREF.test(n.getAttribute("href") || "")) return n.href;
      if (hops > 0) {
        const a = n.querySelector("a[href]");
        if (a && ARTICLE_HREF.test(a.getAttribute("href") || "")) return a.href;
      }
    }
    return null;
  }

  // Separates story headlines from the summaries, blurbs and nav text that share
  // the same shape. Two signals: a real heading tag is always a headline, and
  // within one article card the FIRST piece of text is the headline (the rest is
  // the summary). Deliberately generous -- the editor still offers everything
  // under its "all" view, so a misfire here hides a headline rather than losing it.
  function classify(list) {
    const claimed = new Set();
    for (const c of list) {
      if (/^h[1-4]$/.test(c.tag)) {
        c.kind = "headline";
        if (c.href) claimed.add(c.href);
      } else if (c.href && !claimed.has(c.href)) {
        c.kind = "headline";
        claimed.add(c.href);
      } else {
        c.kind = "text";
      }
    }
    return list;
  }

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
        byKey.set(k, {
          el, text, key: k,
          tag: el.tagName.toLowerCase(),
          href: articleHref(el)
        });
      }
    }
    return classify([...byKey.values()]);
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

  const api = { PUNCT, normalize, key, candidates, findTarget, classify, SELECTOR };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PS_MATCH = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
