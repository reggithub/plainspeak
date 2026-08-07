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
  let onlyEdited = false;

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
  function collect() {
    const day = todayId();
    const expires = defaultExpiry();
    const out = [];

    for (const r of rows) {
      const edited = M.normalize(r.editBox.textContent);
      if (!edited || edited === r.cand.text) continue;

      const ops = D.buildOps(r.cand.text, edited);
      if (!ops.length) continue;

      out.push({
        id: day + "-" + String.fromCharCode(97 + out.length),
        headline: r.cand.text,
        ops,
        source: r.sourceBox.value.trim() || "https://example.com",
        note: r.noteBox.value.trim() || "",
        expires
      });
    }
    return out;
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
    const anns = collect();
    const out = document.getElementById("ps-ed-json");
    out.value = anns.length ? JSON.stringify(anns, null, 2) : "";
    document.getElementById("ps-ed-count").textContent =
      anns.length ? anns.length + " ready" : "none edited yet";
  }

  // ---------------------------------------------------------------------- rows

  function buildRow(cand) {
    const node = el("div", "ps-ed-row");

    const head = el("div", "ps-ed-head");
    head.appendChild(el("span", "ps-ed-tag", cand.tag));
    const orig = el("span", "ps-ed-orig", cand.text);
    orig.title = "click to scroll to this headline on the page";
    head.appendChild(orig);
    node.appendChild(head);

    const editBox = el("div", "ps-ed-input", cand.text);
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
    const noteBox = el("input");
    noteBox.placeholder = "note - why this framing misleads";
    const status = el("span", "ps-ed-status");
    const reset = el("button", "ps-ed-reset", "reset");
    meta.append(sourceBox, noteBox, status, reset);
    node.appendChild(meta);

    const r = { cand, node, editBox, preview, meta, sourceBox, noteBox, status };

    editBox.addEventListener("input", refreshAll);
    sourceBox.addEventListener("input", refreshAll);
    noteBox.addEventListener("input", refreshAll);
    reset.addEventListener("click", () => { editBox.textContent = cand.text; refreshAll(); });

    orig.addEventListener("click", () => {
      cand.el.scrollIntoView({ block: "center", behavior: "smooth" });
      cand.el.classList.add("ps-ed-flash");
      setTimeout(() => cand.el.classList.remove("ps-ed-flash"), 1200);
    });

    return r;
  }

  function applyFilter() {
    for (const r of rows) {
      const changed = r.node.classList.contains("ps-ed-changed");
      r.node.hidden = onlyEdited && !changed;
    }
  }

  // -------------------------------------------------------------------- panel

  function open() {
    const cands = M.candidates({ minWords: 3, skipAttr: "data-plainspeak" });

    const panel = el("div");
    panel.id = ID;

    const bar = el("div", "ps-ed-bar");
    bar.appendChild(el("strong", null, "Plainspeak editor"));
    bar.appendChild(el("span", "ps-ed-sub",
      cands.length + " headline" + (cands.length === 1 ? "" : "s") + " on this page"));

    const filter = el("button", "ps-ed-btn", "show only edited");
    filter.addEventListener("click", () => {
      onlyEdited = !onlyEdited;
      filter.textContent = onlyEdited ? "show all" : "show only edited";
      applyFilter();
    });
    const close = el("button", "ps-ed-btn ps-ed-close", "close");
    close.addEventListener("click", shut);
    bar.append(filter, close);
    panel.appendChild(bar);

    const list = el("div", "ps-ed-list");
    rows = cands.map(buildRow);
    for (const r of rows) list.appendChild(r.node);
    if (!cands.length) {
      list.appendChild(el("div", "ps-ed-empty",
        "No candidates. Either this is not a front page, or everything here is " +
        "already annotated."));
    }
    panel.appendChild(list);

    const foot = el("div", "ps-ed-foot");
    const count = el("span", "ps-ed-sub", "none edited yet");
    count.id = "ps-ed-count";
    const copy = el("button", "ps-ed-btn ps-ed-primary", "copy JSON");
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

    foot.append(count, copy);
    panel.append(foot, json);

    document.body.appendChild(panel);
    refreshAll();
  }

  function shut() {
    const p = document.getElementById(ID);
    if (p) p.remove();
    rows = [];
  }

  document.addEventListener("keydown", (e) => {
    if (e.altKey && (e.key === "e" || e.key === "E")) {
      e.preventDefault();
      document.getElementById(ID) ? shut() : open();
      return;
    }
    if (e.key === "Escape" && document.getElementById(ID)) shut();
  });
})();
