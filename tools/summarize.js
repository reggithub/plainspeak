/* Describe what changed between two versions of annotations.json.
 * Run: node tools/summarize.js <old.json> <new.json>
 *
 * First line is a commit subject; the rest are body lines. Used by publish.ps1
 * so commits say which annotations moved rather than "update annotations.json".
 */

const fs = require("fs");

const read = (p) => {
  try {
    const parsed = JSON.parse(fs.readFileSync(p, "utf8"));
    const map = new Map();
    for (const a of parsed.annotations || []) if (a && a.id) map.set(a.id, a);
    return map;
  } catch {
    return new Map();
  }
};

const [, , oldPath, newPath] = process.argv;
if (!oldPath || !newPath) {
  console.error("usage: node tools/summarize.js <old.json> <new.json>");
  process.exit(2);
}

const before = read(oldPath);
const after = read(newPath);

const added = [...after.keys()].filter((k) => !before.has(k));
const removed = [...before.keys()].filter((k) => !after.has(k));
const updated = [...after.keys()].filter(
  (k) => before.has(k) && JSON.stringify(before.get(k)) !== JSON.stringify(after.get(k))
);

if (!added.length && !removed.length && !updated.length) {
  console.log("NOCHANGE");
  process.exit(0);
}

// Subject: name the headline when exactly one annotation moved -- the common
// case -- and say which direction it moved. Calling a removal "Annotate" read
// as the opposite of what the commit did.
const parts = [];
if (added.length) parts.push("add " + added.length);
if (updated.length) parts.push("update " + updated.length);
if (removed.length) parts.push("remove " + removed.length);

// Keep the whole subject inside the 72 columns git log formats to, trimming the
// headline rather than the verb, and on a word boundary where one is close.
function subject(verb, headline) {
  const room = Math.max(24, 72 - verb.length - 3);
  let h = headline;
  if (h.length > room) {
    h = h.slice(0, room - 3);
    const space = h.lastIndexOf(" ");
    if (space > room * 0.6) h = h.slice(0, space);
    h += "...";
  }
  return verb + " " + JSON.stringify(h);
}

const only = added.length + updated.length + removed.length === 1;
const oneId = [...added, ...updated, ...removed][0];
const oneHeadline = (after.get(oneId) || before.get(oneId) || {}).headline || "";

const verb = added.length ? "Annotate"
           : updated.length ? "Revise annotation for"
           : "Remove annotation for";

console.log(only && oneHeadline
  ? subject(verb, oneHeadline)
  : "Annotations: " + parts.join(", "));

console.log("");
for (const [label, ids] of [["Added", added], ["Updated", updated], ["Removed", removed]]) {
  for (const id of ids) {
    const a = after.get(id) || before.get(id);
    console.log(label + " " + id + "  " + JSON.stringify((a.headline || "").slice(0, 66)));
  }
}
