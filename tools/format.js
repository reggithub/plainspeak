/* Rewrite annotations.json in canonical form.  Run: node tools/format.js
 *
 * Same serializer the editor writes with, so hand edits and editor saves
 * produce identical formatting and a diff shows only what actually changed.
 *
 * --check exits 1 if the file is not already canonical, without touching it.
 */

const fs = require("fs");
const path = require("path");
const { formatFeed } = require("../extension/feed.js");

const FILE = path.join(__dirname, "..", "annotations.json");
const checkOnly = process.argv.includes("--check");

const original = fs.readFileSync(FILE, "utf8");

let parsed;
try {
  parsed = JSON.parse(original);
} catch (e) {
  console.error("annotations.json is not valid JSON: " + e.message);
  process.exit(2);
}

const formatted = formatFeed(parsed);

// The formatter must never change meaning, only whitespace.
if (JSON.stringify(JSON.parse(formatted)) !== JSON.stringify(parsed)) {
  console.error("REFUSING to write: reformatting would change the data");
  process.exit(2);
}

if (formatted === original) {
  console.log("annotations.json is already canonical");
  process.exit(0);
}

if (checkOnly) {
  console.error("annotations.json is not canonical - run: node tools/format.js");
  process.exit(1);
}

fs.writeFileSync(FILE, formatted);

const before = original.split("\n").length;
const after = formatted.split("\n").length;
console.log("reformatted annotations.json (" + before + " -> " + after + " lines)");
