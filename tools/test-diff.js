/* Tests for extension/diff.js.  Run: node tools/test-diff.js
 *
 * The three fixtures are the annotations that were hand-authored in
 * annotations.json. The generated ops must match them exactly -- those were
 * written by a human reading the headline, so they are the standard the
 * generator has to meet.
 */

const { buildOps, readThrough } = require("../extension/diff.js");

let failures = 0;

function eq(label, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log("  ok   " + label); return; }
  failures++;
  console.log("  FAIL " + label + "\n       got  " + g + "\n       want " + w);
}

console.log("fixtures from annotations.json");

const A_O = "Trump Again Targets Birthright Citizenship, in Two Executive Orders";
const A_E = "Trump Again Tries to Kill Constitutionally-protected Birthright Citizenship, in Two Executive Orders";
eq("2026-08-07-a  replace a word mid-headline", buildOps(A_O, A_E), [
  { t: "strike", start: 12, len: 8 },
  { t: "insert", at: 20, text: "Tries to Kill Constitutionally-protected " }
]);

const B_O = "Blanche's Nomination for Attorney General";
const B_E = "Trump's Sometimes Personal Lawyer Todd Blanche's Nomination for Attorney General";
eq("2026-08-07-b  prepend at the start", buildOps(B_O, B_E), [
  { t: "insert", at: 0, text: "Trump's Sometimes Personal Lawyer Todd " }
]);

const C_O = "Republicans Cannot Possibly Let This Congressman Go";
const C_E = "Republicans Cannot Possibly Let This Congressman Go? Look at How They Handled Trump";
eq("2026-08-07-c  append at the end", buildOps(C_O, C_E), [
  { t: "insert", at: 51, text: "? Look at How They Handled Trump" }
]);

console.log("\nedge cases");

eq("no change", buildOps("Same Headline Here", "Same Headline Here"), []);
eq("pure deletion", buildOps("A Very Long Headline", "A Long Headline"), [
  { t: "strike", start: 2, len: 5 }
]);

console.log("\nround trip: readThrough(original, ops) === edited");

const CASES = [
  [A_O, A_E], [B_O, B_E], [C_O, C_E],
  ["One Two Three Four Five", "One Two Three Four Five"],
  ["One Two Three Four Five", "Two Three Four Five"],
  ["One Two Three Four Five", "One Two Three Four Five Six"],
  ["One Two Three Four Five", "Zero One Two Three Four Five"],
  ["One Two Three Four Five", "One Five"],
  ["One Two Three Four Five", "One TWO Three FOUR Five"],
  ["One Two Three Four Five", "Completely Different Text Entirely"],
  ["Senate Passes the Bill", "Senate Passes the Deeply Unpopular Bill"],
  ["Officials Say Cuts Are Modest", "Officials Claim Cuts Are Sweeping"],
  ["A B", "B A"],
  ["Cuts to Medicaid", "Cuts to Medicaid, Which Covers 70 Million People"],
  ["The Fight Over Spending", "The Fight Over Spending Cuts"]
];

for (const [o, e] of CASES) {
  const ops = buildOps(o, e);
  const got = readThrough(o, ops);
  if (got !== e) {
    failures++;
    console.log("  FAIL " + JSON.stringify(o) + " -> " + JSON.stringify(e) +
                "\n       read back " + JSON.stringify(got));
  } else {
    console.log("  ok   " + JSON.stringify(e.slice(0, 46)) + (e.length > 46 ? "..." : ""));
  }
}

console.log("\nops stay in bounds of the original");
for (const [o, e] of CASES) {
  for (const op of buildOps(o, e)) {
    const pos = op.t === "strike" ? op.start : op.at;
    const bad = pos < 0 || pos > o.length ||
                (op.t === "strike" && pos + op.len > o.length);
    if (bad) { failures++; console.log("  FAIL out of bounds " + JSON.stringify(op) + " on " + JSON.stringify(o)); }
  }
}
if (!failures) console.log("  ok   all offsets within range");

console.log(failures ? "\n" + failures + " FAILURE(S)" : "\nall passed");
process.exit(failures ? 1 : 0);
