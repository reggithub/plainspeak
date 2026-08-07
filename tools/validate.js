/* Validate annotations.json.  Run: node tools/validate.js
 *
 * Op offsets are hand-editable integers indexing a string nobody can see, which
 * is exactly the kind of thing that goes quietly wrong. This renders every
 * annotation the way content.js would and flags the ways they can be malformed.
 *
 * Remember: a strike does NOT delete. Struck text stays on the page with a line
 * through it, and the insert sits beside it. "Reads as" below is the sentence a
 * reader takes away -- kept text plus inserts, skipping the struck words.
 */

const fs = require("fs");
const path = require("path");

const { normalize } = require("../extension/match.js");
const { readThrough, pieces } = require("../extension/diff.js");

const FILE = path.join(__dirname, "..", "annotations.json");

let errors = 0, warnings = 0;
const err = (m) => { errors++; console.log("  ERROR   " + m); };
const warn = (m) => { warnings++; console.log("  warn    " + m); };

let feed;
try {
  feed = JSON.parse(fs.readFileSync(FILE, "utf8"));
} catch (e) {
  console.log("ERROR  annotations.json is not valid JSON: " + e.message);
  process.exit(1);
}

const anns = feed.annotations || [];
console.log("annotations.json - " + anns.length + " annotation(s), publication: " +
            JSON.stringify(feed.publication) + "\n");

const seenIds = new Set();
const now = new Date();

for (const ann of anns) {
  const h = ann.headline || "";
  console.log("- " + (ann.id || "(no id)") + "  " + JSON.stringify(h));

  if (!ann.id) err("missing id");
  else if (seenIds.has(ann.id)) err("duplicate id " + ann.id);
  else seenIds.add(ann.id);

  if (!h) { err("missing headline"); console.log(""); continue; }

  // Offsets index the normalized string, so a headline that is not already
  // normalized means the numbers refer to a string that never exists at runtime.
  if (normalize(h) !== h) {
    err("headline is not normalized; offsets will not line up. Expected " +
        JSON.stringify(normalize(h)));
  }

  const ops = Array.isArray(ann.ops) ? ann.ops : [];
  if (!ops.length) warn("no ops - this annotation renders nothing but the source dagger");

  // ---- per-op bounds and word alignment
  const strikes = [];
  for (const op of ops) {
    const pos = op.t === "strike" ? op.start : op.at;

    if (typeof pos !== "number" || pos < 0 || pos > h.length) {
      err("op " + JSON.stringify(op) + " is out of bounds (headline length " + h.length + ")");
      continue;
    }
    if (op.t === "strike") {
      if (pos + op.len > h.length) {
        err("strike " + pos + "+" + op.len + " runs past the end (length " + h.length + ")");
        continue;
      }
      strikes.push([pos, pos + op.len]);

      // A strike that starts or ends inside a word leaves a widowed fragment.
      if (pos > 0 && h[pos - 1] !== " ") {
        warn("strike starts mid-word: kept " + JSON.stringify(h.slice(Math.max(0, pos - 12), pos)) +
             " then strikes " + JSON.stringify(h.slice(pos, pos + op.len)));
      }
      const end = pos + op.len;
      if (end < h.length && h[end] !== " " && h[end - 1] !== " ") {
        warn("strike ends mid-word: strikes " + JSON.stringify(h.slice(pos, end)) +
             " then keeps " + JSON.stringify(h.slice(end, end + 12)));
      }
    } else if (op.t === "insert") {
      // Landing inside a word splits it: at 6 on "Cassidy" yields
      // "Cassid, Future Lobbyist,y". Usually an offset that is off by one.
      if (pos > 0 && pos < h.length && h[pos - 1] !== " " && h[pos] !== " ") {
        err("insert lands inside a word: " + JSON.stringify(h.slice(0, pos)) +
            " + insert + " + JSON.stringify(h.slice(pos)));
      }
      if (typeof op.text !== "string" || !op.text) err("insert has no text");
      else if (/^\s|\s\s|\s$/.test(op.text) && /\s\s/.test(op.text)) {
        warn("insert text has doubled spaces: " + JSON.stringify(op.text));
      }
    } else {
      err("unknown op type " + JSON.stringify(op.t));
    }
  }

  // ---- strikes must not overlap each other
  strikes.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < strikes.length; i++) {
    if (strikes[i][0] < strikes[i - 1][1]) {
      err("strikes overlap: " + JSON.stringify(strikes[i - 1]) + " and " + JSON.stringify(strikes[i]));
    }
  }

  // ---- render exactly as content.js would
  const rendered = pieces(h, ops).map((p) =>
    p.type === "keep" ? p.text :
    p.type === "strike" ? "[-" + p.text + "-]" : "[+" + p.text + "+]").join("");
  const reads = readThrough(h, ops);

  console.log("    renders  " + rendered);
  console.log("    reads as " + JSON.stringify(reads));

  if (/  /.test(reads)) warn("reads with a doubled space");
  if (reads === h) warn("reads identically to the original - the annotation changes nothing");

  // ---- metadata
  if (!ann.source || /example\.com/.test(ann.source)) warn("source is still a placeholder");
  if (!ann.note || /^One sentence on why/.test(ann.note)) warn("note is still placeholder text");

  if (!ann.expires) warn("no expiry - this annotation never lapses");
  else {
    const exp = new Date(ann.expires);
    if (isNaN(exp)) err("expires is not a valid date: " + ann.expires);
    else if (exp < now) warn("EXPIRED on " + ann.expires + " - content.js skips it");
  }

  console.log("");
}

console.log(errors || warnings
  ? errors + " error(s), " + warnings + " warning(s)"
  : "clean");
process.exit(errors ? 1 : 0);
