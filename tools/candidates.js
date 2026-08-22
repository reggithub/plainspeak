/* Plainspeak candidate-headline dump.
 *
 * Paste into the DevTools console on https://www.nytimes.com/ (or a section
 * front). Lists every headline the content script could actually annotate, in
 * the exact normalized form to paste into annotations.json.
 *
 * Why in-page rather than a fetch-and-parse CLI: the matcher runs against the
 * live DOM after NYT's JavaScript has built it. Server HTML is a different
 * document, so anything scraped from it would not reflect what findTarget sees.
 *
 * NOT AUTHORITATIVE. The editor's "misses" view is -- Alt+E, then the misses
 * tab. That runs inside the extension against the real PS_MATCH, so it cannot
 * drift; this file cannot reach PS_MATCH from the page world and has to keep
 * its own copy of the rules, which is exactly how it fell behind before.
 *
 * What is mirrored here: the PUNCT table, normalize(), blockText() and the
 * querySelectorAll/childElementCount/length bounds. What is NOT: the seam and
 * container tests, and the headline/summary split. So this over-reports --
 * cards and summaries show up alongside real headlines. Use it for the ruler
 * and for a quick "is this text on the page at all", not for coverage.
 */

(() => {
  "use strict";

  const MIN_WORDS = 3; // drop nav chrome, bylines, one-word links

  // ---- mirrored from content.js -------------------------------------------

  const PUNCT = {
    "\u2018": "'", "\u2019": "'", "\u201A": "'", "\u201B": "'",
    "\u201C": '"', "\u201D": '"', "\u201E": '"', "\u201F": '"',
    "\u2013": "-", "\u2014": "-", "\u2212": "-",
    "\u00A0": " ", "\u2009": " ", "\u202F": " ", "\u200A": " "
  };

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

  const BLOCKISH = "p, div, h1, h2, h3, h4, h5, h6, ul, ol, li, section, " +
                   "article, header, footer, figure, figcaption, blockquote, br";
  const BLOCK_TAGS = new Set(("P DIV H1 H2 H3 H4 H5 H6 UL OL LI SECTION ARTICLE " +
    "HEADER FOOTER FIGURE FIGCAPTION BLOCKQUOTE BR").split(" "));

  // A block boundary reads as a space, so a headline broken by a <br> or split
  // across wrapper divs normalizes to the sentence a reader actually saw.
  function blockText(el) {
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

  // ---- gather --------------------------------------------------------------

  const els = document.querySelectorAll("h1, h2, h3, h4, p, span, a, div");
  const byKey = new Map();

  for (const el of els) {
    if (el.childElementCount > 12) continue;
    const txt = el.textContent;
    if (!txt || txt.length > 400) continue;

    const text = normalize(blockText(el));
    if (!text) continue;
    if (text.split(" ").length < MIN_WORDS) continue;

    const k = text.toLowerCase();
    const prev = byKey.get(k);

    // findTarget keeps the DEEPEST match, so report that element's depth/tag.
    if (!prev || prev.el.contains(el)) {
      byKey.set(k, { el, text, tag: el.tagName.toLowerCase() });
    }
  }

  const list = [...byKey.values()];

  // ---- cross-reference the live feed --------------------------------------
  //
  // NYT sets a connect-src CSP, so this fetch may be blocked from page context
  // (that CSP is the whole reason background.js exists). Degrade quietly.

  const FEED =
    "https://raw.githubusercontent.com/reggithub/plainspeak/main/annotations.json";

  const report = (covered) => {
    for (const c of list) c.annotated = covered ? covered.has(c.text.toLowerCase()) : "?";

    console.log(
      "%cPlainspeak: %d candidate headlines on %s",
      "font-weight:bold",
      list.length,
      location.pathname
    );
    if (!covered) {
      console.warn("feed fetch blocked by CSP - 'annotated' column unavailable");
    }
    console.table(list.map((c) => ({
      tag: c.tag,
      len: c.text.length,
      annotated: c.annotated,
      headline: c.text
    })));

    window.ps = {
      list,
      /** Unannotated candidates only, as a JSON array ready for copy(). */
      fresh: () => list.filter((c) => c.annotated !== true).map((c) => c.text),
      /** Print a character ruler so op offsets can be read off directly. */
      ruler(s) {
        console.log(s);
        let tens = "";
        for (let i = 0; i < s.length; i++) tens += i % 10 === 0 ? String(i % 100 / 10 | 0) : " ";
        console.log(tens);
        console.log([...s].map((_, i) => i % 10).join(""));
        console.log("length = " + s.length + "  (insert at " + s.length + " appends to the end)");
      },
      /** Scroll to and outline a candidate by index. */
      show(i) {
        const el = list[i].el;
        el.scrollIntoView({ block: "center" });
        el.style.outline = "3px solid #c0261f";
        return el;
      }
    };

    console.log(
      "%cps.fresh()%c  unannotated headlines · %cps.ruler(s)%c  offset ruler · %cps.show(i)%c  highlight",
      "font-weight:bold", "", "font-weight:bold", "", "font-weight:bold", ""
    );
  };

  fetch(FEED, { cache: "no-cache" })
    .then((r) => r.json())
    .then((feed) => report(new Set((feed.annotations || []).map((a) => key(a.headline)))))
    .catch(() => report(null));
})();
