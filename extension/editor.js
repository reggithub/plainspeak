/* Plainspeak in-page editor.
 *
 * Alt+E over an NYT front opens a panel listing every headline the matcher can
 * reach. Rewrite one the way it should have read; the ops are derived from the
 * difference, previewed in the real annotation CSS, and collected into a
 * ready-to-paste annotations array.
 *
 * The editor never writes to annotations.json. Copy the JSON out, paste it in,
 * commit it -- publishing stays a deliberate act.
 */

(() => {
  "use strict";

  const M = PS_MATCH;
  const D = PS_DIFF;
  const ID = "ps-editor";

  let rows = [];   // {cand, edited, source, note, el refs}
  let view = "headline";   // headline | all | edited | feed
  let feed = null;
  let query = "";
  let whole = true;   // emit the entire annotations.json, not just new entries
  const tabs = [];
  const feedRows = [];

  // Every whitespace-separated term must appear, so "cassidy blanche" finds the
  // headline with both regardless of order. Matched against the normalized form
  // so curly quotes and odd spacing in the page text do not defeat a search.
  function matches(text) {
    if (!query.trim()) return true;
    const hay = M.key(text || "");
    return M.key(query).split(" ").filter(Boolean).every((t) => hay.includes(t));
  }

  // ------------------------------------------------------------------- helpers

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  const utcDate = (offsetDays) => {
    const t = new Date();
    return new Date(Date.UTC(
      t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate() + (offsetDays || 0)
    ));
  };

  const todayId = () => utcDate(0).toISOString().slice(0, 10);
  const defaultExpiry = () => utcDate(2).toISOString().replace(".000", "");

  // --------------------------------------------------------------- annotations

  // Rows the reader actually changed, as annotation objects.
  // Next unused id for today. Allocating blindly from "a" is what produced two
  // 2026-08-07-a entries in the file.
  function freeId(day, used) {
    for (let i = 0; i < 26; i++) {
      const id = day + "-" + String.fromCharCode(97 + i);
      if (!used.has(id)) { used.add(id); return id; }
    }
    let n = 1;
    while (used.has(day + "-" + n)) n++;
    used.add(day + "-" + n);
    return day + "-" + n;
  }

  function collect() {
    const day = todayId();
    const expires = defaultExpiry();
    const out = [];

    const used = new Set();
    for (const a of (feed && feed.annotations) || []) if (a && a.id) used.add(a.id);
    for (const r of rows) {
      const edited = M.normalize(r.editBox.textContent);
      // Against the baseline, not the headline: an already-annotated row opens
      // showing its current rewrite, and only belongs in the output once you
      // change it further.
      if (!edited || edited === r.baseline || edited === r.cand.text) continue;

      const ops = D.buildOps(r.cand.text, edited);
      if (!ops.length) continue;

      out.push({
        // Revising an existing annotation keeps its id, so pasting the result
        // replaces that entry rather than adding a duplicate of it.
        id: r.annId || freeId(day, used),
        headline: r.cand.text,
        ops,
        source: r.sourceBox.value.trim() || "https://example.com",
        note: r.noteBox.value.trim() || "",
        expires: r.expires || expires
      });
    }
    return out;
  }

  // The whole of annotations.json: everything already in the feed, with this
  // session's edits merged in by id and new entries appended. Entries for other
  // pages are carried through untouched -- the feed is one file for the whole
  // site, and only some of it is visible here.
  //
  // Resetting an annotated row back to the publisher's own wording removes that
  // annotation, which is the only way to retire one from inside the editor.
  function buildFile() {
    const byId = new Map();
    const order = [];
    const src = base || feed;

    for (const a of (src && src.annotations) || []) {
      if (!a || typeof a !== "object" || Array.isArray(a)) continue;
      const id = a.id || "";
      if (!byId.has(id)) order.push(id);
      byId.set(id, a);
    }

    for (const e of collect()) {
      if (!byId.has(e.id)) order.push(e.id);
      byId.set(e.id, e);
    }

    for (const r of rows) {
      if (!r.annId) continue;
      if (M.normalize(r.editBox.textContent) === r.cand.text) byId.delete(r.annId);
    }

    return {
      publication: (src && src.publication) || "The New York Times",
      annotations: order.filter((id) => byId.has(id)).map((id) => byId.get(id))
    };
  }

  // ------------------------------------------------------------------- preview

  function renderPreview(target, original, ops) {
    target.textContent = "";
    for (const p of D.pieces(original, ops)) {
      if (p.type === "keep") {
        target.appendChild(document.createTextNode(p.text));
      } else {
        // Same class names annotate.css styles on the page, so what shows here
        // is what a reader would see: struck text stays, inserts in script face.
        target.appendChild(el("span", p.type === "strike" ? "ps-del" : "ps-ins", p.text));
      }
    }
  }

  function refreshRow(r) {
    const edited = M.normalize(r.editBox.textContent);
    const changed = edited && edited !== r.cand.text;

    // "changed" drives the preview -- show the annotation whenever one exists.
    // "dirty" drives the edited view and the output: work done this session.
    r.node.classList.toggle("ps-ed-dirty", !!edited && edited !== r.baseline);
    r.node.classList.toggle("ps-ed-changed", !!changed);
    r.meta.hidden = !changed;

    if (!changed) {
      r.preview.textContent = "";
      r.status.textContent = "";
      return;
    }

    const ops = D.buildOps(r.cand.text, edited);
    renderPreview(r.preview, r.cand.text, ops);

    // The ops are generated, so the useful check is whether reading past the
    // strikes actually reproduces what was typed.
    const back = D.readThrough(r.cand.text, ops);
    r.status.textContent = back === edited
      ? ops.length + (ops.length === 1 ? " op" : " ops")
      : "MISMATCH - reads back as: " + back;
    r.status.classList.toggle("ps-ed-bad", back !== edited);
  }

  function refreshAll() {
    for (const r of rows) refreshRow(r);
    captureDrafts();
    applyFilter();

    const anns = collect();
    const out = document.getElementById("ps-ed-json");
    const count = document.getElementById("ps-ed-count");

    if (whole) {
      const file = buildFile();
      out.value = PS_FEED.formatFeed(file);
      // Naming the merge base matters: "feed" means anything committed but not
      // pushed is absent from this output, and saving would revert it. Kept
      // terse so it cannot crowd the buttons; the detail is in the tooltip.
      count.textContent = file.annotations.length + " annotations · " +
        (anns.length ? anns.length + " changed" : "no changes") +
        " · base: " + baseSource;
      count.title = baseSource === "file"
        ? "Merging into the bound annotations.json on disk."
        : "Merging into the published feed - anything committed but not pushed " +
          "is missing from this output, and saving would revert it.";
    } else {
      out.value = anns.length ? PS_FEED.formatAnnotations(anns) : "";
      count.textContent = anns.length ? anns.length + " ready" : "none edited yet";
    }
  }

  // ---------------------------------------------------------------------- rows

  // `ann` is set when this row is an annotation already live on the page. The
  // element's text has been rewritten by then, so the headline comes from the
  // feed and the box opens on the current rewrite.
  function buildRow(cand, ann) {
    const baseline = ann ? D.readThrough(cand.text, ann.ops || []) : cand.text;
    const node = el("div", "ps-ed-row");

    const head = el("div", "ps-ed-head");
    const tag = el("span", "ps-ed-tag", ann ? "annotated" : cand.tag);
    if (ann) {
      tag.classList.add("ps-ed-live");
      tag.title = "already in annotations.json as " + ann.id;
    } else if (cand.href) {
      tag.classList.add("ps-ed-story");
      tag.title = cand.href;
    }
    head.appendChild(tag);
    const orig = el("span", "ps-ed-orig", cand.text);
    orig.title = "click to scroll to this headline on the page";
    head.appendChild(orig);
    node.appendChild(head);

    const editBox = el("div", "ps-ed-input", baseline);
    editBox.contentEditable = "plaintext-only";
    editBox.spellcheck = false;
    node.appendChild(editBox);

    const preview = el("div", "ps-ed-preview");
    node.appendChild(preview);

    const meta = el("div", "ps-ed-meta");
    meta.hidden = true;
    const sourceBox = el("input");
    sourceBox.placeholder = "source URL";
    sourceBox.type = "url";
    // An existing annotation keeps its own metadata; otherwise the card's own
    // link is almost always the right source.
    if (ann && ann.source) sourceBox.value = ann.source;
    else if (cand.href) sourceBox.value = cand.href;
    const noteBox = el("input");
    noteBox.placeholder = "note - why this framing misleads";
    if (ann && ann.note) noteBox.value = ann.note;
    const status = el("span", "ps-ed-status");
    const reset = el("button", "ps-ed-reset", "reset");
    meta.append(sourceBox, noteBox, status, reset);
    node.appendChild(meta);

    const r = {
      cand, node, editBox, preview, meta, sourceBox, noteBox, status, baseline,
      defaults: { source: sourceBox.value, note: noteBox.value },
      annId: ann ? ann.id : null,
      expires: ann ? ann.expires : null
    };

    // Restore an unsaved rewrite of this same headline from a previous session.
    const draft = drafts[cand.key];
    if (draft && draft.edited && draft.edited !== baseline) {
      editBox.textContent = draft.edited;
      if (draft.source) sourceBox.value = draft.source;
      if (draft.note) noteBox.value = draft.note;
      r.restored = true;
    }

    editBox.addEventListener("input", refreshAll);
    sourceBox.addEventListener("input", refreshAll);
    noteBox.addEventListener("input", refreshAll);
    reset.addEventListener("click", () => { editBox.textContent = baseline; refreshAll(); });

    orig.addEventListener("click", () => reveal(cand, true));

    // Entering any field on a row brings its headline into view on the page, so
    // the rewrite is always made against the story as it is actually presented.
    for (const field of [editBox, sourceBox, noteBox]) {
      field.addEventListener("focus", () => reveal(cand, false));
    }

    return r;
  }

  // Bring the headline being edited into view and keep it marked while you work
  // on it, the way the reader's badge menu jumps to an annotation.
  //
  // The test is whether it sits in the middle band, not merely whether it is on
  // screen: a headline clinging to the bottom edge is not where you are looking,
  // and the panel covers the right of the viewport besides.
  function reveal(cand, force) {
    const el = cand.el;
    if (!el || !el.isConnected) return;

    setActive(el);

    const box = el.getBoundingClientRect();
    const h = window.innerHeight;
    const centred = box.top >= h * 0.2 && box.bottom <= h * 0.8;
    if (force || !centred) el.scrollIntoView({ block: "center", behavior: "smooth" });

    flash(el);
  }

  // Persistent marker on the headline whose row has focus. Distinct from the
  // flash, which fades: this one answers "which of these am I editing?".
  function setActive(el) {
    clearActive();
    if (el) el.classList.add("ps-ed-active");
  }

  function clearActive() {
    for (const n of document.querySelectorAll(".ps-ed-active")) n.classList.remove("ps-ed-active");
  }

  function flash(el) {
    el.classList.add("ps-ed-flash");
    setTimeout(() => el.classList.remove("ps-ed-flash"), 1200);
  }

  // Headlines already annotated are skipped by candidates() -- they sit inside
  // [data-plainspeak], and their text has been rewritten anyway, so it no longer
  // matches the stored headline. Without this they vanish from the editor the
  // moment they are annotated and there is no way to revise your own work.
  function addLiveRows(list) {
    if (!feed) return;
    const added = [];

    for (const el2 of document.querySelectorAll("[data-plainspeak]")) {
      const id = el2.getAttribute("data-plainspeak");
      const ann = ((feed.annotations || []).filter((a) => a && a.id === id))[0];
      if (!ann || typeof ann.headline !== "string") continue;

      added.push(buildRow({
        el: el2,
        text: ann.headline,
        key: M.key(ann.headline),
        tag: el2.tagName.toLowerCase(),
        href: ann.source && /^https?:/.test(ann.source) ? ann.source : null,
        kind: "headline"
      }, ann));
    }

    // Top of the list: revising something already published is the more urgent
    // task than starting a new one.
    for (let i = added.length - 1; i >= 0; i--) list.insertBefore(added[i].node, list.firstChild);
    rows = added.concat(rows);
  }

  function applyFilter() {
    const isFeed = view === "feed";
    const listBox = document.getElementById("ps-ed-list");
    const feedBox = document.getElementById("ps-ed-feed");
    if (listBox) listBox.hidden = isFeed;
    if (feedBox) feedBox.hidden = !isFeed;

    let shown = 0;
    for (const r of rows) {
      const dirty = r.node.classList.contains("ps-ed-dirty");
      // A row edited this session stays visible in every view: switching views
      // must never hide work already started. A typed query is authoritative
      // though -- when you are searching you want only what you searched for.
      const inView = view === "all" ? true
                   : view === "edited" ? dirty
                   : r.cand.kind === "headline" || dirty;
      const show = inView && matches(r.cand.text);
      r.node.hidden = !show;
      if (show) shown++;
    }

    let feedShown = 0;
    for (const f of feedRows) {
      const show = matches(f.ann.headline);
      f.node.hidden = !show;
      if (show) feedShown++;
    }

    const counts = {
      headline: rows.filter((r) => r.cand.kind === "headline").length,
      all: rows.length,
      edited: rows.filter((r) => r.node.classList.contains("ps-ed-dirty")).length,
      feed: feed ? (feed.annotations || []).length : 0
    };
    for (const t of tabs) {
      t.btn.textContent = t.label + " " + counts[t.view];
      t.btn.classList.toggle("ps-ed-on", view === t.view);
    }

    const nDrafts = Object.keys(drafts).length;
    const disc = document.getElementById("ps-ed-discard");
    if (disc) {
      disc.hidden = !nDrafts;
      disc.textContent = "discard " + nDrafts + (nDrafts === 1 ? " draft" : " drafts");
    }

    const sub = document.getElementById("ps-ed-sub");
    if (sub) {
      sub.textContent = query.trim()
        ? (isFeed ? feedShown : shown) + " matching “" + query.trim() + "”"
        : rows.filter((r) => r.cand.kind === "headline").length + " of " + rows.length + " matchable";
    }

    const empty = document.getElementById("ps-ed-empty");
    if (empty) {
      empty.hidden = isFeed || shown > 0 || !rows.length;
      if (!empty.hidden && query.trim()) {
        empty.textContent = "Nothing matches “" + query.trim() + "” in this view.";
      }
    }
  }

  // ------------------------------------------------------------ save to project
  //
  // Chrome will not let an extension write an arbitrary path, so the file is
  // bound once through a native picker and the handle is kept. Point it at the
  // repo's annotations.json and later saves overwrite it in place.
  //
  // The handle lives in this origin's IndexedDB, so clearing site data for the
  // publisher means picking the file again. Permission is re-checked on every
  // save; the browser may re-prompt once per session.

  // ---------------------------------------------------------------- drafts
  //
  // Unsaved rewrites survive closing the panel, reloading the page and
  // restarting the browser. Editing a headline is slow, deliberate work; losing
  // it to a stray Escape is not acceptable.
  //
  // chrome.storage.local rather than the page's IndexedDB: extension-scoped, so
  // clearing the publisher's site data does not take the drafts with it. The
  // file handle cannot live here -- it is not JSON -- hence the separate store
  // below. Keyed by normalized headline, which is what identifies a target.

  const DRAFT_KEY = "drafts";
  let drafts = {};
  let draftTimer = null;

  function persistDrafts() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => {
      try { chrome.storage.local.set({ [DRAFT_KEY]: drafts }); } catch (e) { /* storage gone */ }
    }, 300);
  }

  function captureDrafts() {
    for (const r of rows) {
      const edited = M.normalize(r.editBox.textContent);
      if (edited && edited !== r.baseline) {
        drafts[r.cand.key] = {
          edited,
          source: r.sourceBox.value,
          note: r.noteBox.value
        };
      } else {
        delete drafts[r.cand.key];
      }
    }
    persistDrafts();
  }

  function discardDrafts() {
    drafts = {};
    persistDrafts();
    for (const r of rows) {
      r.editBox.textContent = r.baseline;
      r.sourceBox.value = r.defaults.source;
      r.noteBox.value = r.defaults.note;
    }
    refreshAll();
  }

  const DB_NAME = "plainspeak", DB_STORE = "handles", DB_KEY = "annotations";
  let fileHandle = null;

  // What edits get merged into. The bound file when we can read it, otherwise
  // the published feed.
  //
  // This matters more than it looks. The feed is what raw.githubusercontent.com
  // is serving -- behind a five-minute background cache and another five at the
  // CDN, and missing anything committed but not yet pushed. Merging into that
  // and writing the result to disk silently reverts local work. The file on
  // disk is the only honest base.
  let base = null;
  let baseSource = "feed";

  async function readBound() {
    if (!fileHandle) return null;
    try {
      if ((await fileHandle.queryPermission({ mode: "read" })) !== "granted") return null;
      const parsed = JSON.parse(await (await fileHandle.getFile()).text());
      return parsed && Array.isArray(parsed.annotations) ? parsed : null;
    } catch (e) {
      console.warn("[plainspeak] could not read bound file:", e && e.message);
      return null;
    }
  }

  async function loadBase() {
    const onDisk = await readBound();
    base = onDisk || feed;
    baseSource = onDisk ? "file" : "feed";
  }

  function idb(mode, fn) {
    return new Promise((resolve, reject) => {
      const open = indexedDB.open(DB_NAME, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(DB_STORE);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const req = fn(db.transaction(DB_STORE, mode).objectStore(DB_STORE));
        req.onsuccess = () => { resolve(req.result); db.close(); };
        req.onerror = () => { reject(req.error); db.close(); };
      };
    });
  }

  function fallbackDownload(text) {
    const blob = new Blob([text], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "annotations.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  // Always writes the whole file. Writing only the changed entries would leave
  // annotations.json holding a fragment of itself.
  async function saveToProject() {
    if (!window.showSaveFilePicker) {
      fallbackDownload(PS_FEED.formatFeed(buildFile()));
      return "downloaded";
    }

    try {
      // Permission first, and before any await that could outlive the click's
      // user activation -- fileHandle was loaded when the panel opened.
      if (fileHandle) {
        let perm = await fileHandle.queryPermission({ mode: "readwrite" });
        if (perm !== "granted") perm = await fileHandle.requestPermission({ mode: "readwrite" });
        if (perm !== "granted") fileHandle = null;
      }

      if (!fileHandle) {
        fileHandle = await window.showSaveFilePicker({
          suggestedName: "annotations.json",
          types: [{ description: "Plainspeak feed", accept: { "application/json": [".json"] } }]
        });
        await idb("readwrite", (s) => s.put(fileHandle, DB_KEY)).catch(() => {});
      }

      // Re-read immediately before merging. The panel may have been open for a
      // while, and the file can have changed underneath it -- an edit in the
      // IDE, a git pull, another save. Merging into a stale copy would undo it.
      await loadBase();
      const text = PS_FEED.formatFeed(buildFile());

      const w = await fileHandle.createWritable();
      await w.write(text);
      await w.close();

      // The file now holds what we merged, so a second save starts from it and
      // the rows are no longer pending: their current text IS the saved state.
      base = JSON.parse(text);
      baseSource = "file";
      for (const r of rows) r.baseline = M.normalize(r.editBox.textContent);
      drafts = {};
      persistDrafts();
      refreshAll();
      return "saved to " + fileHandle.name;
    } catch (e) {
      if (e && e.name === "AbortError") return "cancelled";
      console.warn("[plainspeak] save failed:", e && e.message);
      fallbackDownload(PS_FEED.formatFeed(buildFile()));
      return "picker failed - downloaded instead";
    }
  }

  // ----------------------------------------------------------------- feed view
  //
  // "Why is only one of my annotations showing?" answered on the page itself.
  // An annotation renders only if its headline matches some element's whole text
  // exactly, so the usual answer is that the stored headline is not what the
  // page actually says.

  function requestFeed(cb) {
    try {
      chrome.runtime.sendMessage({ type: "plainspeak:getFeed" }, (data) => {
        cb(chrome.runtime.lastError ? null : data);
      });
    } catch {
      cb(null);
    }
  }

  // The page headline that looks most like this one, by shared words.
  function nearest(headline, cands) {
    const want = new Set(M.key(headline).split(" "));
    let best = null, bestScore = 0;
    for (const c of cands) {
      const have = c.key.split(" ");
      let hits = 0;
      for (const w of have) if (want.has(w)) hits++;
      const score = hits / Math.max(want.size, have.length);
      if (score > bestScore) { bestScore = score; best = c; }
    }
    return bestScore >= 0.4 ? best : null;
  }

  function statusOf(ann, cands) {
    if (ann.expires && Date.parse(ann.expires) < Date.now()) {
      return { state: "expired", why: "expired " + ann.expires };
    }
    const esc = window.CSS && CSS.escape ? CSS.escape(ann.id || "") : ann.id;
    if (document.querySelector('[data-plainspeak="' + esc + '"]')) {
      return { state: "shown", why: "rendered on this page" };
    }
    if (M.findTarget(M.key(ann.headline || ""), null)) {
      return { state: "pending", why: "matches, not applied yet - reload the page" };
    }
    return {
      state: "missing",
      why: "no element on this page has exactly this text",
      near: nearest(ann.headline || "", cands)
    };
  }

  function renderFeed(cands) {
    const box = document.getElementById("ps-ed-feed");
    if (!box) return;
    box.textContent = "";
    feedRows.length = 0;

    if (!feed) {
      box.appendChild(el("div", "ps-ed-empty",
        "Could not read the feed from the background worker."));
      return;
    }

    const anns = feed.annotations || [];
    for (const ann of anns) {
      const s = statusOf(ann, cands);
      const row = el("div", "ps-ed-frow");

      const line = el("div", "ps-ed-head");
      line.appendChild(el("span", "ps-ed-state ps-ed-" + s.state, s.state));
      line.appendChild(el("span", "ps-ed-fid", ann.id || "(no id)"));
      row.appendChild(line);

      row.appendChild(el("div", "ps-ed-fhead", ann.headline || ""));
      row.appendChild(el("div", "ps-ed-sub", s.why));

      if (s.near) {
        const hint = el("div", "ps-ed-near");
        hint.appendChild(el("span", "ps-ed-sub", "page says: "));
        const t = el("span", "ps-ed-orig", s.near.text);
        t.addEventListener("click", () => reveal(s.near, true));
        hint.appendChild(t);
        row.appendChild(hint);
      }
      box.appendChild(row);
      feedRows.push({ ann, node: row });
    }

    if (!anns.length) box.appendChild(el("div", "ps-ed-empty", "The feed is empty."));
  }

  // -------------------------------------------------------------------- panel

  function open() {
    // minWords 2, not 3: short headlines are real, and the headline filter now
    // does the work of keeping nav chrome out of the default view.
    const cands = M.candidates({ minWords: 2, skipAttr: "data-plainspeak" });

    const panel = el("div");
    panel.id = ID;

    const bar = el("div", "ps-ed-bar");
    bar.appendChild(el("strong", null, "Plainspeak editor"));
    const heads = cands.filter((c) => c.kind === "headline").length;
    const sub = el("span", "ps-ed-sub", heads + " of " + cands.length + " matchable");
    sub.id = "ps-ed-sub";
    bar.appendChild(sub);

    tabs.length = 0;
    for (const [v, label] of [["headline", "headlines"], ["all", "all"],
                              ["edited", "edited"], ["feed", "feed"]]) {
      const btn = el("button", "ps-ed-btn", label);
      btn.addEventListener("click", () => { view = v; applyFilter(); });
      tabs.push({ view: v, label, btn });
      bar.appendChild(btn);
    }

    const close = el("button", "ps-ed-btn ps-ed-close", "close");
    close.addEventListener("click", shut);
    bar.appendChild(close);
    panel.appendChild(bar);

    const filterRow = el("div", "ps-ed-filterbar");
    const q = el("input", "ps-ed-q");
    q.type = "search";
    q.placeholder = "filter headlines…";
    q.spellcheck = false;
    q.addEventListener("input", () => { query = q.value; applyFilter(); });
    filterRow.appendChild(q);
    panel.appendChild(filterRow);

    const list = el("div", "ps-ed-list");
    rows = cands.map((c) => buildRow(c));   // not cands.map(buildRow): the index would arrive as `ann`
    for (const r of rows) list.appendChild(r.node);

    const empty = el("div", "ps-ed-empty", !cands.length
      ? "Nothing matchable here. Either this is not a page the extension runs on, " +
        "or everything on it is already annotated."
      : "No rows in this view. Try “all” — the headline filter looks for a " +
        "story link, and some cards do not have one.");
    empty.id = "ps-ed-empty";
    empty.hidden = true;
    list.appendChild(empty);
    list.id = "ps-ed-list";
    panel.appendChild(list);

    const feedBox = el("div", "ps-ed-list");
    feedBox.id = "ps-ed-feed";
    feedBox.hidden = true;
    panel.appendChild(feedBox);

    requestFeed((data) => {
      feed = data;
      addLiveRows(list);
      renderFeed(cands);
      refreshAll();
      // Prefer the file on disk as the merge base once the handle is back.
      handleReady.then(loadBase).then(refreshAll);
    });

    const foot = el("div", "ps-ed-foot");
    const count = el("span", "ps-ed-sub", "none edited yet");
    count.id = "ps-ed-count";
    const discard = el("button", "ps-ed-btn", "discard drafts");
    discard.id = "ps-ed-discard";
    discard.hidden = true;
    discard.title = "Throw away every unsaved rewrite, including ones restored from an earlier session";
    discard.addEventListener("click", discardDrafts);

    const mode = el("button", "ps-ed-btn", "whole file");
    const save = el("button", "ps-ed-btn", "save to project");
    const copy = el("button", "ps-ed-btn ps-ed-primary", "copy JSON");

    save.title = "Write the whole file to annotations.json. " +
                 "The first save asks which file to bind to; after that it overwrites in place.";
    save.addEventListener("click", async () => {
      save.disabled = true;
      const was = save.textContent;
      save.textContent = "saving…";
      const result = await saveToProject();
      save.textContent = result;
      save.disabled = false;
      setTimeout(() => { save.textContent = was; }, 2600);
    });

    // Loaded now so the click handler can call requestPermission without
    // spending its user activation on an await first.
    const handleReady = idb("readonly", (s) => s.get(DB_KEY))
      .then((h) => { if (h) { fileHandle = h; save.title = "Overwrites " + h.name; } })
      .catch(() => {});
    mode.title = "Whole file replaces annotations.json outright. " +
                 "New entries only gives just what changed here.";
    mode.addEventListener("click", () => {
      whole = !whole;
      mode.textContent = whole ? "whole file" : "new entries";
      refreshAll();
    });

    const json = el("textarea");
    json.id = "ps-ed-json";
    json.readOnly = true;
    json.placeholder = "Rewrite a headline above and the annotations appear here.";

    copy.addEventListener("click", async () => {
      if (!json.value) return;
      try {
        await navigator.clipboard.writeText(json.value);
        copy.textContent = "copied";
      } catch {
        json.select(); // clipboard API can be blocked; leave it selected
        copy.textContent = "press Ctrl+C";
      }
      setTimeout(() => { copy.textContent = "copy JSON"; }, 1600);
    });

    // Buttons in their own wrapping row. Flat in the footer they shared a line
    // with the status text, which is long enough to push them out of a 560px
    // panel entirely -- the save button simply was not on screen.
    const actions = el("div", "ps-ed-actions");
    actions.append(discard, mode, save, copy);
    foot.append(count, actions);
    panel.append(foot, json);

    document.body.appendChild(panel);
    refreshAll();
    q.focus();
  }

  function shut() {
    const p = document.getElementById(ID);
    if (p) p.remove();
    clearActive();
    rows = [];
    feedRows.length = 0;
    query = "";
  }

  // Load drafts at script start so they are in hand before the panel is opened.
  try {
    chrome.storage.local.get(DRAFT_KEY, (o) => {
      if (o && o[DRAFT_KEY]) drafts = o[DRAFT_KEY];
    });
  } catch (e) { /* storage unavailable; drafts simply will not persist */ }

  document.addEventListener("keydown", (e) => {
    if (e.altKey && (e.key === "e" || e.key === "E")) {
      e.preventDefault();
      document.getElementById(ID) ? shut() : open();
      return;
    }
    if (e.key === "Escape" && document.getElementById(ID)) {
      // Escape clears a live search before it closes the panel, so a typo does
      // not cost you the rows you have already edited.
      const q = document.querySelector("#" + ID + " .ps-ed-q");
      if (query.trim() && q) {
        q.value = "";
        query = "";
        applyFilter();
        q.focus();
        return;
      }
      shut();
    }
  });
})();
