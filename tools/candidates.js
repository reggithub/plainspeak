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
 * The filters below MIRROR extension/content.js -- the PUNCT table, normalize(),
 * and the querySelectorAll/childElementCount/length rules in findTarget(). If
 * you change matching there, change it here too or this tool will lie to you.
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

  // ---- gather --------------------------------------------------------------

  const els = document.querySelectorAll("h1, h2, h3, h4, p, span, a, div");
  const byKey = new Map();

  for (const el of els) {
    if (el.childElementCount > 4) continue;
    const txt = el.textContent;
    if (!txt || txt.length > 400) continue;

    const text = normalize(txt);
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
