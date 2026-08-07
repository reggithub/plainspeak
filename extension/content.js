// Plainspeak content script.
//
// Contract:
//   - Never removes publisher text. Struck words stay visible.
//   - Renders nothing unless the live headline matches the reviewed headline exactly
//     (after normalization). A silently-rewritten headline yields no annotation.
//   - Every annotation carries a visible source link and Plainspeak attribution.

(() => {
  "use strict";

  const DONE_ATTR = "data-plainspeak";
  let applying = false;
  let feed = null;

  // ---------------------------------------------------------------- normalize
  //
  // Produces a normalized string plus a map back to the original character
  // indices, so annotation offsets computed against the normalized form can be
  // applied to the real DOM text.

  const PUNCT = {
    "\u2018": "'", "\u2019": "'", "\u201A": "'", "\u201B": "'",
    "\u201C": '"', "\u201D": '"', "\u201E": '"', "\u201F": '"',
    "\u2013": "-", "\u2014": "-", "\u2212": "-",
    "\u00A0": " ", "\u2009": " ", "\u202F": " ", "\u200A": " "
  };

  function normalize(raw) {
    const out = [];
    const map = []; // map[i] = index into raw
    let pendingSpace = false;

    for (let i = 0; i < raw.length; i++) {
      let ch = raw[i];
      if (PUNCT[ch]) ch = PUNCT[ch];

      if (/\s/.test(ch)) {
        pendingSpace = out.length > 0;
        continue;
      }
      if (pendingSpace) {
        out.push(" ");
        map.push(i);
        pendingSpace = false;
      }
      out.push(ch);
      map.push(i);
    }
    return { text: out.join(""), map };
  }

  const key = (s) => normalize(s).text.toLowerCase();

  // ------------------------------------------------------------ text indexing
  //
  // Flattens an element's text nodes into one string, remembering which node and
  // offset each character came from. Handles headlines split across <span>s.

  function flatten(el) {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const chars = [];
    const nodes = [];
    const offsets = [];
    let n;
    while ((n = walker.nextNode())) {
      const t = n.nodeValue;
      for (let i = 0; i < t.length; i++) {
        chars.push(t[i]);
        nodes.push(n);
        offsets.push(i);
      }
    }
    return { raw: chars.join(""), nodes, offsets };
  }

  // --------------------------------------------------------------- candidates
  //
  // The deepest element whose text equals the headline. Deepest matters: an
  // ancestor container may also "contain" the headline, and rewriting that would
  // destroy neighbouring content.

  function findTarget(headlineKey) {
    const nodes = document.querySelectorAll(
      "h1, h2, h3, h4, p, span, a, div"
    );
    let best = null;
    for (const el of nodes) {
      if (el.hasAttribute(DONE_ATTR)) continue;
      if (el.childElementCount > 4) continue;
      const txt = el.textContent;
      if (!txt || txt.length > 400) continue;
      if (key(txt) !== headlineKey) continue;
      if (!best || el.compareDocumentPosition(best) & Node.DOCUMENT_POSITION_CONTAINS) {
        best = el;
      } else if (best.contains(el)) {
        best = el;
      }
    }
    return best;
  }

  // ------------------------------------------------------------------- render

  function span(cls, text) {
    const s = document.createElement("span");
    s.className = cls;
    s.textContent = text;
    return s;
  }

  function applyOps(el, ann) {
    const flat = flatten(el);
    const norm = normalize(flat.raw);
    const nText = norm.text;

    // Sort descending so applying one op never shifts the offsets of the next.
    const ops = [...ann.ops].sort((a, b) => {
      const pa = a.t === "strike" ? a.start : a.at;
      const pb = b.t === "strike" ? b.start : b.at;
      return pb - pa;
    });

    for (const op of ops) {
      const pos = op.t === "strike" ? op.start : op.at;
      if (pos < 0 || pos > nText.length) return false;
      if (op.t === "strike" && pos + op.len > nText.length) return false;
    }

    // Rebuild the element's text content with annotation spans woven in.
    // Inner markup inside the headline is not preserved; headlines rarely carry
    // meaningful markup, and this is far more robust than Range surgery.
    const pieces = []; // {type, text}
    let cursor = 0;
    const asc = [...ops].reverse();

    for (const op of asc) {
      const pos = op.t === "strike" ? op.start : op.at;
      if (pos > cursor) {
        pieces.push({ type: "keep", text: nText.slice(cursor, pos) });
        cursor = pos;
      }
      if (op.t === "strike") {
        pieces.push({ type: "strike", text: nText.slice(pos, pos + op.len) });
        cursor = pos + op.len;
      } else {
        pieces.push({ type: "insert", text: op.text });
      }
    }
    if (cursor < nText.length) {
      pieces.push({ type: "keep", text: nText.slice(cursor) });
    }

    const frag = document.createDocumentFragment();
    for (const p of pieces) {
      if (p.type === "keep") {
        frag.appendChild(document.createTextNode(p.text));
      } else if (p.type === "strike") {
        const s = span("ps-del", p.text);
        s.setAttribute("aria-label", "struck by Plainspeak: " + p.text);
        frag.appendChild(s);
      } else {
        const s = span("ps-ins", p.text);
        s.setAttribute("aria-label", "Plainspeak annotation: " + p.text);
        frag.appendChild(s);
      }
    }

    if (ann.source) {
      const a = document.createElement("a");
      a.className = "ps-cite";
      a.href = ann.source;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = "\u2020";
      a.title = (ann.note ? ann.note + " \u2014 " : "") + "Source: " + ann.source;
      a.setAttribute("aria-label", "Plainspeak source note. " + (ann.note || ""));
      a.addEventListener("click", (e) => e.stopPropagation());
      frag.appendChild(a);
    }

    el.textContent = "";
    el.appendChild(frag);
    el.setAttribute(DONE_ATTR, ann.id || "1");
    el.classList.add("ps-annotated");
    return true;
  }

  // -------------------------------------------------------------------- badge

  function badge(count) {
    let b = document.getElementById("ps-badge");
    if (!b) {
      b = document.createElement("div");
      b.id = "ps-badge";
      document.body.appendChild(b);
    }
    const msg =
      count === 0
        ? "Plainspeak: nothing annotated on this page"
        : "Plainspeak: " + count + (count === 1 ? " annotation" : " annotations") +
          " on this page \u00b7 other headlines were not reviewed";

    // Write only on change. An unconditional write mutates the DOM, which wakes
    // the MutationObserver, which schedules another run, which writes again --
    // a 350ms loop that never settles.
    if (b.textContent !== msg) b.textContent = msg;
  }

  // ----------------------------------------------------------------- main run

  function run() {
    if (!feed || applying) return;
    applying = true;
    const now = Date.now();

    for (const ann of feed.annotations || []) {
      if (ann.expires && Date.parse(ann.expires) < now) continue;
      const k = key(ann.headline);
      const el = findTarget(k);
      if (!el) continue;
      applyOps(el, ann);
    }

    // Count what is actually marked in the DOM. A module-level tally only ever
    // grows, because run() re-fires on every mutation.
    badge(document.querySelectorAll("[" + DONE_ATTR + "]").length);
    applying = false;
  }

  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(run, 350);
  }

  chrome.runtime.sendMessage({ type: "plainspeak:getFeed" }, (data) => {
    if (chrome.runtime.lastError || !data) return;
    feed = data;
    run();
    new MutationObserver(() => {
      if (!applying) schedule();
    }).observe(document.body, { childList: true, subtree: true });
  });

  // Alt+P toggles annotations off so the reader can see the unmodified page.
  document.addEventListener("keydown", (e) => {
    if (e.altKey && (e.key === "p" || e.key === "P")) {
      document.documentElement.classList.toggle("ps-off");
    }
  });
})();
