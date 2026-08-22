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
  // itself, or wrap the whole card the text sits inside.
  //
  // This used to stop after four parentElement hops. NYT's front nests a card's
  // headline six to ten levels below its <a>, so the walk gave up and returned
  // null -- and classify() can only call an hrefless, non-heading element
  // "text". The page's biggest stories are <p> and <span>, not <h3>, so exactly
  // the substantive headlines fell out of the editor's default view while nav
  // chrome shallow enough to find its link stayed in. closest() has no depth
  // limit and is the native ancestor walk, so it is both correct and faster.
  function articleHref(el) {
    const own = el.closest("a[href]");
    if (own && ARTICLE_HREF.test(own.getAttribute("href") || "")) return own.href;

    // No enclosing link: the text may be a sibling of one, inside a card that
    // links from a child instead. Bounded, because at enough hops every element
    // "contains" some article link and the answer stops meaning anything.
    let n = el.parentElement;
    for (let hops = 0; n && hops < 4; hops++, n = n.parentElement) {
      const a = n.querySelector("a[href]");
      if (a && ARTICLE_HREF.test(a.getAttribute("href") || "")) return a.href;
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

  // Elements whose presence means the text is laid out in blocks. Annotating
  // works by rebuilding an element's contents as text plus annotation spans,
  // which flattens whatever was inside it -- fine for a headline, destructive
  // for a card, where the kicker, headline and badge are separate blocks and
  // collapse onto one line.
  const BLOCKISH = "p, div, h1, h2, h3, h4, h5, h6, ul, ol, li, section, " +
                   "article, header, footer, figure, figcaption, blockquote, br";

  // Whether annotating this element would preserve the page. Nothing may be
  // annotated unless this holds -- a mis-keyed annotation must render nothing,
  // never damage the publisher's layout.
  function safeToRewrite(el) {
    if (el.querySelector(BLOCKISH)) return false;
    return !hasSeam(el);
  }

  // Shortest run of words that will be taken for a headline over something else
  // pointing at the same story. Kickers -- "Live", "Analysis", "Times
  // Investigation" -- fall under it; headlines essentially never do.
  const MIN_HEADLINE_WORDS = 3;

  // Fixtures in test-match.js carry no text; treat that as "long enough".
  const wordCount = (c) =>
    c.text == null ? Infinity : c.text.trim().split(/\s+/).filter(Boolean).length;

  // How big this text is actually drawn, cached per candidate.
  //
  // Document order was the wrong way to pick the headline out of a card. On a
  // photo card the credit -- "Saul Martinez for The New York Times" -- comes
  // first in the DOM and is long enough to pass for a headline, so it claimed
  // the story link and the real headline was demoted to text. Size is the
  // signal a reader uses and the one the page is built around: the headline is
  // drawn larger than the summary, the credit and the "6 MIN READ" badge.
  //
  // Only ever called for candidates that share a story link, which is a handful
  // per page -- getComputedStyle forces layout and is too costly to run over
  // every element on an NYT front.
  function fontSize(c) {
    if (c.size != null) return c.size;
    c.size = 0;
    try {
      if (c.el && typeof getComputedStyle === "function") {
        c.size = parseFloat(getComputedStyle(c.el).fontSize) || 0;
      }
    } catch (e) { /* detached node, or no view */ }
    return c.size;
  }

  // Is `a` the better headline for a story than `b`? Falls back to word count
  // and then to document order, which is all the plain-object test fixtures --
  // and any page where the sizes tie -- have to go on.
  function better(a, b) {
    const fa = fontSize(a), fb = fontSize(b);
    if (fa !== fb) return fa > fb;
    const la = wordCount(a) >= MIN_HEADLINE_WORDS, lb = wordCount(b) >= MIN_HEADLINE_WORDS;
    if (la !== lb) return la;
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
    const eligible = list.filter((c) => !c.seam && !c.container);

    // Headings claim their story link before anything else looks at it. Done in
    // one pass rather than inline, because a summary sitting earlier in the list
    // used to take the slot and leave the real headline classified as text.
    const claimed = new Set();
    for (const c of eligible) if (/^h[1-4]$/.test(c.tag) && c.href) claimed.add(c.href);

    // One headline per story link. Prefer the first candidate long enough to be
    // one: a card's kicker -- "Times Investigation", "Live" -- resolves to the
    // same link and, being shallower, often reaches the list first. Fall back to
    // the first candidate outright, so a genuinely short headline is not lost.
    const winner = new Map();
    for (const c of eligible) {
      if (!c.href || claimed.has(c.href)) continue;
      const cur = winner.get(c.href);
      if (!cur || better(c, cur)) winner.set(c.href, c);
    }

    // `why` is only for the editor's misses view, which has to explain a
    // headline that is on the page but not in the default list.
    for (const c of list) {
      if (c.seam) { c.kind = "text"; c.why = "text runs together — a card, not a sentence"; }
      else if (c.container) { c.kind = "text"; c.why = "wraps other candidates — a card, not a headline"; }
      else if (/^h[1-4]$/.test(c.tag)) c.kind = "headline";
      else if (!c.href) { c.kind = "text"; c.why = "no story link found from here"; }
      else if (winner.get(c.href) === c) c.kind = "headline";
      else {
        c.kind = "text";
        const w = winner.get(c.href);
        c.why = "this story link is already claimed by " +
          (w ? "<" + w.tag + "> “" + (w.text || "").slice(0, 60) + "”" : "a heading");
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

  const opts_ = (opts) => Object.assign({ minWords: 3, skipAttr: null }, opts);

  // Why this element cannot be offered as a headline, or its normalized text
  // when it can. Pulled out of candidates() so the reasons have one home and
  // anything else that needs to explain a skipped headline can reuse them.
  function inspect(el, opts) {
    const o = opts_(opts);

    if (el.closest(OURS)) return { reason: "Plainspeak's own UI" };

    // A photo credit sits above the headline in the DOM and is easily long
    // enough to look like one. It is never the story's headline.
    if (el.closest("figcaption")) return { reason: "photo caption or credit" };

    if (o.skipAttr && el.closest("[" + o.skipAttr + "]")) return { reason: "already annotated" };
    if (el.childElementCount > MAX_CHILDREN) {
      return { reason: "more than " + MAX_CHILDREN + " child elements" };
    }

    const raw = el.textContent;
    if (!raw) return { reason: "no text" };
    if (raw.length > MAX_LEN) return { reason: "longer than " + MAX_LEN + " characters" };

    const text = normalize(raw);
    if (!text) return { reason: "no text" };

    const n = text.split(" ").length;
    if (n < o.minWords) return { reason: "only " + n + (n === 1 ? " word" : " words") };

    // Never offer what the matcher will refuse to touch.
    if (!safeToRewrite(el)) return { reason: "text runs together — a card, not a sentence" };

    return { text };
  }

  // Every element whose whole text could be a headline, deduped by normalized
  // key. Keeps the DEEPEST element per key: an ancestor may also "contain" the
  // headline, and rewriting that would destroy neighbouring content.
  function candidates(opts) {
    const o = opts_(opts);
    const byKey = new Map();

    for (const el of document.querySelectorAll(SELECTOR)) {
      const got = inspect(el, o);
      if (!got.text) continue;
      const text = got.text;

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

      // A match is not enough. Rewriting a container flattens its blocks and
      // wrecks the page, so an annotation keyed to one renders nothing instead.
      if (!safeToRewrite(el)) continue;

      if (!best || best.contains(el)) best = el;
    }
    return best;
  }

  const api = {
    PUNCT, normalize, key, candidates, findTarget, classify, hasSeam,
    markContainers, safeToRewrite, inspect, SELECTOR
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PS_MATCH = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
