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
  // Shared with the editor via match.js, which the manifest loads first. Both
  // must agree on what a headline is, or the editor emits annotations that
  // silently never render.

  const { key } = PS_MATCH;

  // --------------------------------------------------------------- candidates
  //
  // The deepest element whose text equals the headline. Deepest matters: an
  // ancestor may also "contain" the headline, and annotating that would put the
  // strikes and inserts around neighbouring content as well.

  const findTarget = (headlineKey) => PS_MATCH.findTarget(headlineKey, DONE_ATTR);

  // ------------------------------------------------------------------- render

  // The ops themselves are applied by apply.js, which splits the element's
  // existing text nodes rather than rebuilding it. Everything left here is the
  // annotation's furniture: the source dagger, the attribution class, the mark
  // that stops the next run re-annotating the same headline.
  function applyOps(el, ann) {
    if (!PS_APPLY.applyOps(el, ann.ops || [], document)) return false;

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
      el.appendChild(a);
    }

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
      b.title = "Click to list the annotated headlines";
      b.addEventListener("click", toggleList);
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
    if (b.textContent !== msg) {
      b.textContent = msg;
      b.classList.toggle("ps-has", count > 0);
      // An open list is now stale. Rebuilding here is safe only because this
      // branch is gated on the count actually changing.
      if (document.getElementById("ps-list")) buildList();
    }
  }

  // ------------------------------------------------------------- headline list
  //
  // The badge is the only always-visible piece of Plainspeak on the page, so it
  // doubles as the way in: click it for what was annotated, click an entry to go
  // there. Entries read as the annotation reads -- past the strikes -- because
  // that is the sentence the annotation is arguing for.

  function annById(id) {
    for (const a of (feed && feed.annotations) || []) if (a && a.id === id) return a;
    return null;
  }

  function goTo(el) {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("ps-target");
    setTimeout(() => el.classList.remove("ps-target"), 1500);
  }

  function buildList() {
    const old = document.getElementById("ps-list");
    if (old) old.remove();

    const marked = [...document.querySelectorAll("[" + DONE_ATTR + "]")];
    const panel = document.createElement("div");
    panel.id = "ps-list";

    const head = document.createElement("div");
    head.className = "ps-list-head";
    head.textContent = marked.length
      ? marked.length + (marked.length === 1 ? " annotated headline" : " annotated headlines")
      : "Nothing annotated on this page";
    panel.appendChild(head);

    for (const el of marked) {
      const ann = annById(el.getAttribute(DONE_ATTR));
      const row = document.createElement("button");
      row.className = "ps-list-row";
      row.type = "button";

      // readThrough gives the rewritten sentence; fall back to the live text if
      // the feed entry has gone (id renamed, annotation removed mid-session).
      let label;
      try {
        label = ann ? PS_DIFF.readThrough(ann.headline, ann.ops || []) : el.textContent;
      } catch {
        label = el.textContent;
      }
      row.textContent = label;

      row.addEventListener("click", (e) => { e.stopPropagation(); goTo(el); });
      panel.appendChild(row);
    }

    document.body.appendChild(panel);
  }

  function closeList() {
    const p = document.getElementById("ps-list");
    if (p) p.remove();
  }

  function toggleList(e) {
    if (e) e.stopPropagation();
    if (document.getElementById("ps-list")) closeList();
    else buildList();
  }

  // Click anywhere else, or Escape, dismisses it.
  document.addEventListener("click", (e) => {
    const p = document.getElementById("ps-list");
    if (p && !p.contains(e.target) && e.target.id !== "ps-badge") closeList();
  });

  // ----------------------------------------------------------------- main run

  function run() {
    if (!feed || applying) return;
    applying = true;
    const now = Date.now();

    // The feed is hand-edited JSON. One malformed entry must not take the rest
    // of it down, and must not leave `applying` stuck true -- that would wedge
    // the observer and stop every later run, not just this one.
    try {
      for (const ann of feed.annotations || []) {
        if (!ann || typeof ann !== "object" || typeof ann.headline !== "string") {
          console.warn("[plainspeak] skipping malformed feed entry:", ann);
          continue;
        }
        if (ann.expires && Date.parse(ann.expires) < now) continue;

        const el = findTarget(key(ann.headline));
        if (!el) continue;

        try {
          applyOps(el, ann);
        } catch (e) {
          console.warn("[plainspeak] " + (ann.id || "?") + " failed to apply:", e.message);
        }
      }

      // Count what is actually marked in the DOM. A module-level tally only ever
      // grows, because run() re-fires on every mutation.
      badge(document.querySelectorAll("[" + DONE_ATTR + "]").length);
    } finally {
      applying = false;
    }
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
      closeList();
      return;
    }
    if (e.key === "Escape") closeList();
  });
})();
