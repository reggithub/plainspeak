/* Tests for the headline/summary split in extension/match.js.
 * Run: node tools/test-match.js
 *
 * classify() decides what shows in the editor's default "headlines" view. The
 * cases below are the NYT front-page card shapes it has to get right.
 */

const { classify, normalize, key, hasSeam, safeToRewrite } = require("../extension/match.js");

let failures = 0;

function check(label, input, wantKinds) {
  const got = classify(input).map((c) => c.kind);
  if (JSON.stringify(got) === JSON.stringify(wantKinds)) {
    console.log("  ok   " + label);
  } else {
    failures++;
    console.log("  FAIL " + label + "\n       got  " + JSON.stringify(got) +
                "\n       want " + JSON.stringify(wantKinds));
  }
}

const A = "https://www.nytimes.com/2026/08/07/us/politics/one.html";
const B = "https://www.nytimes.com/2026/08/07/world/two.html";

console.log("card shapes");

check("heading + summary in one card",
  [{ tag: "h3", href: A }, { tag: "p", href: A }],
  ["headline", "text"]);

check("headline and summary both <p> - first wins",
  [{ tag: "p", href: A }, { tag: "p", href: A }],
  ["headline", "text"]);

check("two separate stories",
  [{ tag: "p", href: A }, { tag: "p", href: B }],
  ["headline", "headline"]);

check("nav text with no story link is not a headline",
  [{ tag: "span", href: null }, { tag: "div", href: null }],
  ["text", "text"]);

check("a heading is a headline even without a link",
  [{ tag: "h1", href: null }, { tag: "h2", href: null }],
  ["headline", "headline"]);

// Was a known over-count: the summary reached the loop first and claimed the
// link, and the heading was marked a headline anyway, so the card yielded two.
// Headings now claim their link in a pass of their own, before anything else
// looks at it, so the summary is correctly demoted whatever order it arrives in.
check("summary before heading in the same card - heading still wins",
  [{ tag: "p", href: A }, { tag: "h3", href: A }],
  ["text", "headline"]);

// The kicker is shallower than the headline, so it reaches the list first and
// used to take the slot -- on a front page where most headlines are <p>, that
// silently hid the biggest stories.
check("a short kicker does not outrank the headline it sits above",
  [{ tag: "span", href: A, text: "Times Investigation" },
   { tag: "p", href: A, text: "How the Fouled Reflecting Pool Came to Mirror Washington" }],
  ["text", "headline"]);

check("a genuinely short headline is still kept when nothing longer shares its link",
  [{ tag: "p", href: A, text: "Blanche Confirmed" }],
  ["headline"]);

// The photo card that this came from. In the DOM the credit comes FIRST, before
// the headline, and is seven words long -- so picking the earliest candidate
// over three words handed it the story link and demoted the real headline to
// text. Nothing about the markup separates them; only the drawn size does.
globalThis.getComputedStyle = (n) => ({ fontSize: ((n && n.px) || 12) + "px" });

check("a photo credit does not outrank the headline below it",
  [{ tag: "figcaption", href: A, el: { px: 11 }, text: "Saul Martinez for The New York Times" },
   { tag: "p", href: A, el: { px: 22 },
     text: "A Progressive Democrat in Florida Gave Her Party New Hope, and New Fears" },
   { tag: "p", href: A, el: { px: 15 },
     text: "Angie Nixon, a state lawmaker from Jacksonville, shocked Democrats in red Florida." },
   { tag: "span", href: A, el: { px: 10 }, text: "6 MIN READ" }],
  ["text", "headline", "text", "text"]);

delete globalThis.getComputedStyle;

check("three-deck card: headline, summary, byline",
  [{ tag: "p", href: A }, { tag: "p", href: A }, { tag: "span", href: A }],
  ["headline", "text", "text"]);

check("a card wrapping other candidates is not a headline",
  [{ tag: "div", href: A, container: true }, { tag: "p", href: A }],
  ["text", "headline"]);

check("run-together text is not a headline",
  [{ tag: "div", href: A, seam: true }, { tag: "p", href: A }],
  ["text", "headline"]);

console.log("\nseam detection");

// hasSeam only touches childNodes/textContent, so plain objects stand in for
// the DOM. Each case is markup from an NYT front, written out as nodes.
const node = (t) => ({ textContent: t });
const elem = (...kids) => ({ childNodes: kids });

const SEAMS = [
  ["kicker + headline + badge run together",
    elem(node("Times Investigation"), node("How the Pool Came to Mirror"), node("11 min read")), true],
  ["headline followed by a reading badge",
    elem(node("Meta Ordered to Pay $567 Million"), node("2 min read")), true],
  ["inline emphasis inside a headline",
    elem(node("Trump Says "), node("No Deal"), node(" to Congress")), false],
  ["a single text node",
    elem(node("Cassidy Will Back Blanche, Salvaging His Confirmation")), false],
  ["children separated by whitespace nodes",
    elem(node("Senate Passes"), node(" "), node("the Bill")), false],
  ["empty nodes are skipped, not treated as separators",
    elem(node("Activists Tell"), node(""), node("of Abuse")), true]
];

for (const [label, el, want] of SEAMS) {
  const got = hasSeam(el);
  if (got === want) console.log("  ok   " + label);
  else { failures++; console.log("  FAIL " + label + " -> " + got + ", want " + want); }
}

console.log("\nsafeToRewrite - annotating flattens an element, so blocks inside are fatal");

// querySelector is the only DOM call safeToRewrite makes beyond hasSeam.
const target = (sel, kids) => ({
  querySelector: (q) => (sel ? { tag: sel } : null),
  childNodes: kids || [node("A Perfectly Ordinary Headline")]
});

const SAFE = [
  ["plain headline, one text node", target(null), true],
  ["headline with an inline <em>", target(null,
    [node("Trump Says "), node("No Deal"), node(" to Congress")]), true],
  ["card containing a <p>", target("p"), false],
  ["anything containing a <br>", target("br"), false],
  ["no blocks but text runs together", target(null,
    [node("Times Investigation"), node("How the Pool")]), false]
];

for (const [label, el, want] of SAFE) {
  const got = safeToRewrite(el);
  if (got === want) console.log("  ok   " + label);
  else { failures++; console.log("  FAIL " + label + " -> " + got + ", want " + want); }
}

console.log("\nnormalize");

const N = [
  ["  Trump’s  “Big”  Plan ", "Trump's \"Big\" Plan"],
  ["A B—C", "A B-C"],
  ["Already Clean Text", "Already Clean Text"],
  ["", ""]
];
for (const [raw, want] of N) {
  const got = normalize(raw);
  if (got === want) console.log("  ok   " + JSON.stringify(raw));
  else { failures++; console.log("  FAIL " + JSON.stringify(raw) + " -> " + JSON.stringify(got)); }
}

const curly = "Blanche’s Nomination for Attorney General";
const straight = "Blanche's Nomination for Attorney General";
if (key(curly) === key(straight)) console.log("  ok   curly and straight apostrophes match");
else { failures++; console.log("  FAIL apostrophe folding"); }

console.log(failures ? "\n" + failures + " FAILURE(S)" : "\nall passed");
process.exit(failures ? 1 : 0);
