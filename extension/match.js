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
  const OURS = "#ps-editor, #ps-badge, #ps-list";

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

  // True when this element's text is several pieces run together rather than one
  // run of prose. textContent concatenates children with no separator, so a card
  // wrapping a kicker, a headline and a badge yields
  //
  //   "Times InvestigationHow the Fouled Reflecting Pool...Washington11 min read"
  //
  // The seam is the giveaway: a child boundary with no whitespace either side.
  // A headline with inline markup -- "Trump Says <em>No</em> to the Deal" -- has
  // spaces around its children and shows no seam.
  function hasSeam(el) {
    let prevEnd = "";
    for (const node of el.childNodes) {
      const t = node.textContent || "";
      if (!t) continue;
      if (prevEnd && !/\s/.test(prevEnd) && !/\s/.test(t[0])) return true;
      prevEnd = t[t.length - 1];
    }
    return false;
  }

  // Separates story headlines from the summaries, blurbs, cards and nav text that
  // share the same shape.
  //
  //   seam or container -> not a headline. Something more precise sits inside it.
  //   heading tag       -> headline.
  //   first text in a card -> headline; whatever follows is the summary.
  //
  // Deliberately generous: the editor still offers everything under its "all"
  // view, so a misfire hides a headline rather than losing it.
  function classify(list) {
    const claimed = new Set();
    for (const c of list) {
      if (c.seam || c.container) {
        c.kind = "text";
        continue;
      }
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

  // An element that wraps other candidates is a card, not a headline. Requires
  // two element children so that <h3>Trump Says <em>No Deal</em></h3> -- one
  // child, no seam -- is left alone. Headings are exempt: a heading holding
  // sub-elements is still the headline.
  function markContainers(list) {
    const elems = new Set(list.map((c) => c.el));
    const containers = new Set();

    for (const c of list) {
      for (let p = c.el.parentElement; p; p = p.parentElement) {
        if (elems.has(p) && p.childElementCount >= 2) containers.add(p);
      }
    }
    for (const c of list) {
      c.container = containers.has(c.el) && !/^h[1-4]$/.test(c.tag);
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
          href: articleHref(el),
          seam: hasSeam(el)
        });
      }
    }
    return classify(markContainers([...byKey.values()]));
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

  const api = {
    PUNCT, normalize, key, candidates, findTarget, classify, hasSeam,
    markContainers, SELECTOR
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PS_MATCH = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
