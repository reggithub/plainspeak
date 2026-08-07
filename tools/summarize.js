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

// Subject: lead with whichever kind of change dominates, and name the headline
// when there is exactly one -- that is the common case and the useful one.
const parts = [];
if (added.length) parts.push("add " + added.length);
if (updated.length) parts.push("update " + updated.length);
if (removed.length) parts.push("remove " + removed.length);

const only = added.length + updated.length + removed.length === 1;
const oneId = [...added, ...updated, ...removed][0];
const oneHeadline = (after.get(oneId) || before.get(oneId) || {}).headline || "";

console.log(only && oneHeadline
  ? "Annotate " + JSON.stringify(oneHeadline.slice(0, 60))
  : "Annotations: " + parts.join(", "));

console.log("");
for (const [label, ids] of [["Added", added], ["Updated", updated], ["Removed", removed]]) {
  for (const id of ids) {
    const a = after.get(id) || before.get(id);
    console.log(label + " " + id + "  " + JSON.stringify((a.headline || "").slice(0, 66)));
  }
}
