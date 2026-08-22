/* Tests for extension/apply.js.  Run: node tools/test-apply.js
 *
 * applyOps resolves an op offset -- which indexes the normalized string -- to a
 * position in the live text nodes, then splits those nodes to weave annotation
 * spans in. Two things have to hold, and neither is visible by reading it:
 *
 *   1. What a reader takes away matches readThrough(headline, ops) exactly.
 *      Struck text stays on the page, so "reads as" means kept text plus
 *      inserts, skipping anything inside a .ps-del.
 *   2. Not one character of the publisher's text is lost, and not one element
 *      moves. That is the contract the whole extension rests on.
 *
 * The DOM below is the smallest thing apply.js will accept: text nodes that can
 * splitText, elements that can insertBefore. No library, to keep the project
 * dependency-free.
 */

const M = require("../extension/match.js");
const { applyOps } = require("../extension/apply.js");
const { readThrough, buildOps } = require("../extension/diff.js");

let failures = 0;
const fail = (m) => { failures++; console.log("  FAIL " + m); };

// ------------------------------------------------------------------ tiny DOM

function detach(n) {
  if (!n.parentNode) return;
  const k = n.parentNode.childNodes;
  const i = k.indexOf(n);
  if (i >= 0) k.splice(i, 1);
  n.parentNode = null;
}

function Text(value) {
  return {
    nodeType: 3,
    nodeValue: value,
    parentNode: null,
    get textContent() { return this.nodeValue; },
    get nextSibling() {
      const k = this.parentNode.childNodes;
      return k[k.indexOf(this) + 1] || null;
    },
    // Keeps [0, at) in this node and returns a new sibling holding the rest --
    // the behaviour apply.js relies on to keep earlier offsets valid.
    splitText(at) {
      const tail = Text(this.nodeValue.slice(at));
      this.nodeValue = this.nodeValue.slice(0, at);
      const k = this.parentNode.childNodes;
      k.splice(k.indexOf(this) + 1, 0, tail);
      tail.parentNode = this.parentNode;
      return tail;
    }
  };
}

function Elem(tag, ...kids) {
  const self = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    className: "",
    attrs: {},
    childNodes: [],
    parentNode: null,
    get childElementCount() { return self.childNodes.filter((k) => k.nodeType === 1).length; },
    get textContent() { return self.childNodes.map((k) => k.textContent).join(""); },
    set textContent(v) { self.childNodes = []; if (v) self.appendChild(Text(v)); },
    setAttribute(k, v) { self.attrs[k] = v; },
    querySelector: () => (deepBlock(self) ? {} : null),
    // Both of these move the node, as the real DOM does: it leaves its old
    // parent. Wrapping a strike depends on it -- insertBefore puts the span in
    // place, then appendChild pulls the text out of the parent and into it.
    appendChild(n) { detach(n); n.parentNode = self; self.childNodes.push(n); return n; },
    insertBefore(n, ref) {
      detach(n);
      n.parentNode = self;
      const i = ref ? self.childNodes.indexOf(ref) : -1;
      self.childNodes.splice(i < 0 ? self.childNodes.length : i, 0, n);
      return n;
    }
  };
  for (const k of kids) self.appendChild(k);
  return self;
}

const deepBlock = (n) => (n.childNodes || []).some(
  (c) => c.nodeType === 1 && (M.BLOCK_TAGS.has(c.tagName) || deepBlock(c)));

const doc = { createElement: (tag) => Elem(tag) };

// What a reader takes away: everything except the text inside a .ps-del.
function readsAs(el) {
  let out = "";
  (function walk(n) {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) { out += c.nodeValue; continue; }
      if (c.nodeType !== 1) continue;
      if (/\bps-del\b/.test(c.className)) continue;
      if (M.BLOCK_TAGS.has(c.tagName)) out += " ";
      walk(c);
      if (M.BLOCK_TAGS.has(c.tagName)) out += " ";
    }
  })(el);
  return M.normalize(out);
}

// Every character the publisher wrote, still present and still in order.
function publisherText(el) {
  let out = "";
  (function walk(n) {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) { out += c.nodeValue; continue; }
      if (c.nodeType !== 1) continue;
      if (/\bps-ins\b/.test(c.className)) continue;   // ours, not theirs
      if (M.BLOCK_TAGS.has(c.tagName)) out += " ";
      walk(c);
      if (M.BLOCK_TAGS.has(c.tagName)) out += " ";
    }
  })(el);
  return M.normalize(out);
}

// ------------------------------------------------------------------ fixtures
//
// Each is a shape from an NYT front. The last three were unreachable before
// apply.js existed: safeToRewrite refused anything with a block inside.

const T = Text, E = Elem;

const SHAPES = [
  ["one text node", () => E("h3", T("Trump Again Targets Birthright Citizenship, in Two Executive Orders"))],

  ["inline <em> inside the headline", () =>
    E("h3", T("Trump Again "), E("em", T("Targets")), T(" Birthright Citizenship, in Two Executive Orders"))],

  ["headline split across sibling spans", () =>
    E("h3", E("span", T("Trump Again Targets Birthright")),
            E("span", T(" Citizenship, in Two Executive Orders")))],

  ["headline wrapped several elements deep", () =>
    E("div", E("div", E("a", E("p",
      T("Trump Again Targets Birthright Citizenship, in Two Executive Orders")))))],

  ["headline broken by a <br>", () =>
    E("h1", T("Trump Again Targets Birthright"), E("br"),
            T("Citizenship, in Two Executive Orders"))],

  ["one wrapper <div> per line", () =>
    E("h1", E("div", T("Trump Again Targets Birthright")),
            E("div", T("Citizenship, in Two Executive Orders")))],

  ["curly quotes the publisher chose", () =>
    E("h3", T("Trump Again “Targets” Birthright Citizenship, in Two Executive Orders"))]
];

// Rewrites to try against every shape. Offsets are derived, not hand-written,
// so the fixtures stay honest when a headline changes.
const REWRITES = [
  ["strike and replace mid-headline",
   "Trump Again Tries to Kill Constitutionally-protected Birthright Citizenship, in Two Executive Orders"],
  ["prepend at position 0", "PRESIDENT Trump Again Targets Birthright Citizenship, in Two Executive Orders"],
  ["append at the end", "Trump Again Targets Birthright Citizenship, in Two Executive Orders, Again"],
  ["strike a run that crosses the line break",
   "Trump Again Targets Something Else Entirely, in Two Executive Orders"],
  ["two separate edits in one headline",
   "Trump Repeatedly Targets Birthright Citizenship, in Several Executive Orders"],
  ["pure deletion", "Trump Targets Birthright Citizenship, in Two Executive Orders"]
];

console.log("apply.js against every shape a headline takes on the front page\n");

for (const [shapeName, build] of SHAPES) {
  const headline = M.normalize(M.blockText(build()));
  // Block-aware, because publisherText() walks the same way blockText does.
  const before = headline;
  let ok = true;

  for (const [editName, editedRaw] of REWRITES) {
    // The curly-quote shape has a different headline, so derive the edit from
    // whatever this shape actually says rather than the literal above.
    const edited = shapeName.startsWith("curly")
      ? editedRaw.replace("Targets", "“Targets”")
      : editedRaw;

    const ops = buildOps(headline, M.normalize(edited));
    const el = build();

    if (!applyOps(el, ops, doc)) { fail(shapeName + " / " + editName + " - ops rejected"); ok = false; continue; }

    const want = M.normalize(readThrough(headline, ops));
    const got = readsAs(el);
    if (got !== want) {
      fail(shapeName + " / " + editName + "\n       reads as " + JSON.stringify(got) +
           "\n       want     " + JSON.stringify(want));
      ok = false;
    }

    // Nothing of the publisher's may be lost, moved or reordered.
    if (publisherText(el) !== before) {
      fail(shapeName + " / " + editName + " - publisher text changed:\n       " +
           JSON.stringify(publisherText(el)) + "\n       " + JSON.stringify(M.normalize(before)));
      ok = false;
    }
  }

  if (ok) console.log("  ok   " + shapeName);
}

console.log("\nstructure is left exactly as the publisher built it");

{
  const el = Elem("h1",
    Elem("div", Text("Trump Again Targets Birthright")),
    Elem("div", Text("Citizenship, in Two Executive Orders")));
  const headline = M.normalize(M.blockText(el));
  const ops = buildOps(headline, headline.replace("Targets", "Tries to Kill"));

  applyOps(el, ops, doc);

  // The two line divs must still be the h1's only element children. The old
  // rebuild would have collapsed them into a single flat run of text.
  const kids = el.childNodes.filter((k) => k.nodeType === 1);
  if (kids.length === 2 && kids.every((k) => k.tagName === "DIV")) {
    console.log("  ok   both line <div>s survive with the annotation inside them");
  } else {
    fail("wrapper divs did not survive: " + JSON.stringify(kids.map((k) => k.tagName)));
  }
}

console.log("\nthe publisher's own typography is left alone");

{
  // The old rebuild wrote the NORMALIZED string back into the element, which
  // quietly replaced NYT's curly quotes and em dashes with ASCII. Nothing is
  // rewritten now, so the characters they chose are still the ones on screen.
  const raw = "Trump’s “Big” Plan — Targets Birthright Citizenship";
  const el = Elem("h3", Text(raw));
  const headline = M.normalize(M.blockText(el));
  applyOps(el, buildOps(headline, headline.replace("Targets", "Tries to Kill")), doc);

  const still = ["’", "“", "”", "—"].filter((ch) => el.textContent.includes(ch));
  if (still.length === 4) console.log("  ok   curly quotes and the em dash survive annotation");
  else fail("typography was normalized away; only " + JSON.stringify(still) + " left");
}

console.log("\nops that do not fit render nothing at all");

{
  const el = Elem("h3", Text("A Short Headline"));
  const cases = [
    ["strike past the end", [{ t: "strike", start: 2, len: 900 }]],
    ["negative offset", [{ t: "insert", at: -1, text: "x" }]],
    ["insert past the end", [{ t: "insert", at: 900, text: "x" }]],
    ["unknown op type", [{ t: "swap", at: 2, text: "x" }]],
    ["insert with no text", [{ t: "insert", at: 2 }]]
  ];
  for (const [label, ops] of cases) {
    const target = Elem("h3", Text("A Short Headline"));
    const applied = applyOps(target, ops, doc);
    if (applied) fail(label + " was applied, should have been refused");
    else if (target.textContent !== "A Short Headline") fail(label + " damaged the element");
    else console.log("  ok   " + label);
  }
  void el;
}

console.log(failures ? "\n" + failures + " FAILURE(S)" : "\nall passed");
process.exit(failures ? 1 : 0);
