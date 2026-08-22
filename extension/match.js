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
  //
  // Also returns src[]: for each character of the result, the index in `raw` it
  // came from. A collapsed whitespace run points at the FIRST space of the run.
  // That is what lets content.js turn an op offset -- which indexes the
  // normalized string -- back into a position in the live text nodes.
  function normalizeMap(raw) {
    const out = [];
    const src = [];
    let pendingAt = -1;
    for (let i = 0; i < raw.length; i++) {
      let ch = raw[i];
      if (PUNCT[ch]) ch = PUNCT[ch];
      if (/\s/.test(ch)) {
        if (out.length > 0 && pendingAt < 0) pendingAt = i;
        continue;
      }
      if (pendingAt >= 0) { out.push(" "); src.push(pendingAt); pendingAt = -1; }
      out.push(ch);
      src.push(i);
    }
    return { text: out.join(""), src };
  }

  const normalize = (raw) => normalizeMap(raw).text;

  const key = (s) => normalize(s).toLowerCase();

  const SELECTOR = "h1, h2, h3, h4, p, span, a, div";
  const MAX_LEN = 400;

  // Was 4, which is a fine bound for a headline made of inline spans but drops
  // one built out of per-line wrapper elements. applyOps no longer cares how
  // many children an element has, so this is only a sanity ceiling now.
  const MAX_CHILDREN = 12;

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

  // Elements that put a visible break in the text around them.
  const BLOCKISH = "p, div, h1, h2, h3, h4, h5, h6, ul, ol, li, section, " +
                   "article, header, footer, figure, figcaption, blockquote, br";

  const BLOCK_TAGS = new Set(("P DIV H1 H2 H3 H4 H5 H6 UL OL LI SECTION ARTICLE " +
    "HEADER FOOTER FIGURE FIGCAPTION BLOCKQUOTE BR").split(" "));

  // The text of an element as the matcher sees it.
  //
  // textContent concatenates with no separator, so a headline broken across
  // lines -- "Trump Wants to Move On<br>From the Middle East", or one wrapper
  // <div> per line -- collapses to "Move OnFrom", which is not a sentence any
  // reader saw and never matches anything anybody would type. Rendering a block
  // boundary as a space fixes that; normalize() then collapses the run.
  //
  // Identical to textContent whenever there are no blocks inside, which is
  // every annotation authored before this existed.
  function blockText(el) {
    // Leaf first: no children at all means nothing to walk, and it skips the
    // querySelector for most of the several thousand elements on a front page.
    if (!el.childElementCount) return el.textContent || "";
    if (!el.querySelector(BLOCKISH)) return el.textContent || "";
    let out = "";
    (function walk(n) {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) { out += c.nodeValue; continue; }
        if (c.nodeType !== 1) continue;
        const block = BLOCK_TAGS.has(c.tagName);
        if (block) out += " ";
        walk(c);
        if (block) out += " ";
      }
    })(el);
    return out;
  }

  // blockText again, remembering which text node and offset every character
  // came from, so ops can be applied to the live nodes instead of rebuilding
  // the element. Block spaces are synthetic and carry node null.
  //
  // Must stay character-for-character identical to blockText; test-match.js
  // asserts it on every fixture.
  function flattenText(el) {
    const chars = [], nodes = [], offsets = [];
    (function walk(n) {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) {
          const t = c.nodeValue;
          for (let i = 0; i < t.length; i++) { chars.push(t[i]); nodes.push(c); offsets.push(i); }
          continue;
        }
        if (c.nodeType !== 1) continue;
        const block = BLOCK_TAGS.has(c.tagName);
        if (block) { chars.push(" "); nodes.push(null); offsets.push(-1); }
        walk(c);
        if (block) { chars.push(" "); nodes.push(null); offsets.push(-1); }
      }
    })(el);
    return { raw: chars.join(""), nodes, offsets };
  }

  // True when this element's text is several pieces run together rather than one
  // run of prose. A card wrapping a kicker, a headline and a badge yields
  //
  //   "Times InvestigationHow the Fouled Reflecting Pool...Washington11 min read"
  //
  // The seam is the giveaway: a child boundary with no whitespace either side.
  // A headline with inline markup -- "Trump Says <em>No</em> to the Deal" -- has
  // spaces around its children and shows no seam.
  function hasSeam(el) {
    let prevEnd = "";
    for (const node of el.childNodes) {
      // A block child or a <br> is a visible break, and blockText renders it as
      // a space, so it separates rather than seams. Without this a two-line
      // headline looks exactly like a card and is refused.
      if (node.nodeType === 1 && BLOCK_TAGS.has(node.tagName)) { prevEnd = " "; continue; }
      const t = node.textContent || "";
      if (!t) continue;
      if (prevEnd && !/\s/.test(prevEnd) && !/\s/.test(t[0])) return true;
      prevEnd = t[t.length - 1];
    }
    return false;
  }

  // Whether annotating this element would preserve the page. Nothing may be
  // annotated unless this holds -- a mis-keyed annotation must render nothing,
  // never damage the publisher's layout.
  //
  // This used to refuse any element with a block descendant, because applyOps
  // rebuilt the element's contents and flattening a card collapsed its kicker,
  // headline and badge onto one line. applyOps now splits the existing text
  // nodes and leaves every element in place, so there is nothing left to
  // flatten and the ban has been lifted -- which is what makes a headline
  // wrapped in per-line <div>s reachable at all.
  //
  // A card still gets past this test and still must not be offered as a
  // headline; markContainers/classify are what demote it.
  function safeToRewrite(el) {
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
  //
  // Known limitation, now that blocks are allowed as candidates: a headline
  // split across per-line wrapper elements is a container too, and if the
  // wrapper is not a heading it is demoted while its half-headlines are
  // offered. Structurally that is indistinguishable from a card holding a
  // kicker and a headline, so there is nothing to test on. The misses view
  // names it -- "wraps other candidates" -- and the "all" tab still offers the
  // wrapper, which is the whole reason that tab exists.
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
  // when it can. Both the candidate scan and the editor's "misses" view go
  // through here, so the list of what was skipped and the reasons given for
  // skipping it cannot drift apart.
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

    // Cheap bound first. blockText only ever ADDS spaces, so anything already
    // past the limit by textContent is past it either way.
    const rough = el.textContent;
    if (!rough) return { reason: "no text" };
    if (rough.length > MAX_LEN) return { reason: "longer than " + MAX_LEN + " characters" };

    const text = normalize(blockText(el));
    if (!text) return { reason: "no text" };

    const n = text.split(" ").length;
    if (n < o.minWords) return { reason: "only " + n + (n === 1 ? " word" : " words") };

    // Never offer what the matcher will refuse to touch.
    if (!safeToRewrite(el)) return { reason: "text runs together — a card, not a sentence" };

    return { text };
  }

  // Every element whose whole text could be a headline, deduped by normalized
  // key. Keeps the DEEPEST element per key: an ancestor may also "contain" the
  // headline, and annotating that would wrap neighbouring content too.
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

  // blockText differs from textContent only by inserted spaces, so with every
  // space removed the two are identical. That makes this a sound cheap filter:
  // anything whose squeezed text differs cannot match, and we skip it without
  // paying for the block-aware walk.
  const squeeze = (s) => key(s).replace(/ /g, "");

  // The single deepest element matching one headline key, or null.
  function findTarget(headlineKey, skipAttr) {
    let best = null;
    const squeezed = headlineKey.replace(/ /g, "");

    for (const el of document.querySelectorAll(SELECTOR)) {
      if (el.closest(OURS)) continue;
      if (skipAttr && el.hasAttribute(skipAttr)) continue;
      if (el.childElementCount > MAX_CHILDREN) continue;

      const txt = el.textContent;
      if (!txt || txt.length > MAX_LEN) continue;
      if (squeeze(txt) !== squeezed) continue;
      if (key(blockText(el)) !== headlineKey) continue;

      // A match is not enough. Rewriting a container flattens its blocks and
      // wrecks the page, so an annotation keyed to one renders nothing instead.
      if (!safeToRewrite(el)) continue;

      if (!best || best.contains(el)) best = el;
    }
    return best;
  }

  // Every story link on the page, paired with the candidate the editor would
  // offer for it. A link with no headline-kind candidate is a story the reader
  // can see and the editor cannot reach -- which is the failure worth hunting,
  // because nothing else on screen says it happened.
  function coverage(cands) {
    const best = new Map();
    for (const c of cands) {
      if (!c.href) continue;
      const cur = best.get(c.href);
      if (!cur || (c.kind === "headline" && cur.kind !== "headline")) best.set(c.href, c);
    }

    const out = [];
    const seen = new Set();
    for (const a of document.querySelectorAll("a[href]")) {
      if (a.closest(OURS)) continue;
      if (!ARTICLE_HREF.test(a.getAttribute("href") || "")) continue;
      if (seen.has(a.href)) continue;
      seen.add(a.href);
      out.push({ href: a.href, link: a, cand: best.get(a.href) || null });
    }
    return out;
  }

  // For a story the editor cannot reach: the elements inside its link that came
  // closest, each with the reason it was passed over. Longest text first --
  // whatever the headline is, it is usually the longest run in the card.
  function nearMisses(link, opts) {
    const o = opts_(opts);
    const out = [];
    for (const el of link.querySelectorAll(SELECTOR)) {
      const got = inspect(el, o);
      const text = got.text || normalize(blockText(el));
      if (!text || text.split(" ").length < 2) continue;
      out.push({ el, text, tag: el.tagName.toLowerCase(), reason: got.reason || null });
    }
    out.sort((a, b) => b.text.length - a.text.length);
    return out.slice(0, 3);
  }

  const api = {
    PUNCT, normalize, normalizeMap, key, squeeze, candidates, findTarget,
    classify, hasSeam, markContainers, safeToRewrite, blockText, flattenText,
    inspect, coverage, nearMisses,
    SELECTOR, BLOCKISH, BLOCK_TAGS, MAX_LEN, MAX_CHILDREN
  };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PS_MATCH = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
