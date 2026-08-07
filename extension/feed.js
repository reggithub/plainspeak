/* Canonical serialization of annotations.json.
 *
 * JSON.stringify(file, null, 2) explodes every op onto four lines, so rewriting
 * the file reformats entries nobody touched and a one-annotation change shows up
 * as ~140 changed lines. That buries the actual edit in `git log -p` and makes
 * review of a feed -- the thing that rewrites other people's pages -- harder
 * than it should be.
 *
 * This matches the format the file was hand-written in: two-space nesting, one
 * op per line. Unknown keys are preserved rather than dropped; this is somebody
 * else's data and the formatter has no business editing it.
 *
 * Loadable as a content script (sets PS_FEED) or via require() for tools.
 */

(function (root, factory) {
  "use strict";
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.PS_FEED = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  const OP_KEYS = ["t", "start", "len", "at", "text"];
  const ANN_KEYS = ["id", "headline", "ops", "source", "note", "expires"];

  const pair = (k, v) => JSON.stringify(k) + ": " + JSON.stringify(v);

  // Ordered keys first, then anything else in its own order, so a field this
  // formatter has never heard of still survives a round trip.
  function ordered(obj, known) {
    const out = [];
    for (const k of known) if (Object.prototype.hasOwnProperty.call(obj, k)) out.push(k);
    for (const k of Object.keys(obj)) if (!known.includes(k)) out.push(k);
    return out;
  }

  function inlineOp(op) {
    return "{ " + ordered(op, OP_KEYS).map((k) => pair(k, op[k])).join(", ") + " }";
  }

  function formatAnnotation(ann, indent) {
    const i = indent, j = indent + "  ";
    const keys = ordered(ann, ANN_KEYS).filter((k) => k !== "ops");
    const lines = [i + "{"];

    // ops sits where it was declared, not bolted on the end.
    const order = ordered(ann, ANN_KEYS);
    order.forEach((k, n) => {
      const last = n === order.length - 1;
      const comma = last ? "" : ",";
      if (k === "ops") {
        const ops = ann.ops || [];
        if (!ops.length) { lines.push(j + '"ops": []' + comma); return; }
        lines.push(j + '"ops": [');
        ops.forEach((op, m) => {
          lines.push(j + "  " + inlineOp(op) + (m === ops.length - 1 ? "" : ","));
        });
        lines.push(j + "]" + comma);
      } else {
        lines.push(j + pair(k, ann[k]) + comma);
      }
    });

    void keys;
    lines.push(i + "}");
    return lines;
  }

  function formatFeed(file) {
    const anns = file.annotations || [];
    const lines = ["{"];

    for (const k of Object.keys(file)) {
      if (k !== "annotations") lines.push("  " + pair(k, file[k]) + ",");
    }

    if (!anns.length) {
      lines.push('  "annotations": []');
    } else {
      lines.push('  "annotations": [');
      anns.forEach((a, n) => {
        const block = formatAnnotation(a, "    ");
        block[block.length - 1] += (n === anns.length - 1 ? "" : ",");
        for (const l of block) lines.push(l);
      });
      lines.push("  ]");
    }

    lines.push("}");
    return lines.join("\n") + "\n";
  }

  // A bare array of annotations, formatted the same way, for pasting into an
  // existing file by hand.
  function formatAnnotations(anns) {
    if (!anns || !anns.length) return "[]\n";
    const lines = ["["];
    anns.forEach((a, n) => {
      const block = formatAnnotation(a, "  ");
      block[block.length - 1] += (n === anns.length - 1 ? "" : ",");
      for (const l of block) lines.push(l);
    });
    lines.push("]");
    return lines.join("\n") + "\n";
  }

  return { formatFeed, formatAnnotations };
});
