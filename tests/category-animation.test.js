// Category open/close slides (issue #72).
//
// Tapping a category's name or chevron used to replace its section in one
// frame. The fix animates the card body over the SAME .18s ease the header
// chevron already uses, updates the header at the tap, and falls back to
// today's instant repaint under reduced motion (or where Element.animate is
// missing). All of that lives in browser code that no node test can run, so
// these checks pin the parts that would silently regress: the shared timing,
// the reduced-motion gate, the header-at-the-tap call, and the cancellation
// that stops a detached body being left mid-slide.
//
// Run with: node --test tests/category-animation.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

// The body of a named function, from its declaration to its closing brace at
// the block's own indent.
function bodyOf(name) {
  const start = INDEX.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name}() is missing`);
  const rest = INDEX.slice(start);
  const end = rest.indexOf('\n    }\n');
  assert.notEqual(end, -1, `${name}() has no closing brace`);
  return rest.slice(0, end);
}

test('the body slide and the chevron share one .18s timing', () => {
  assert.match(INDEX, /const CAT_ANIM_MS = 180;/);
  assert.match(INDEX, /\.cat-head \.chev \{[^}]*transition: transform \.18s ease;/);
});

test('reduced motion, and engines without Element.animate, keep the instant snap', () => {
  const gate = bodyOf('catAnimates');
  assert.match(gate, /prefersReducedMotion\(\)/);
  assert.match(gate, /Element\.prototype\.animate/);
});

test('a header tap updates the header at once and slides the body', () => {
  const toggle = bodyOf('toggleCatCollapsed');
  assert.match(toggle, /updateCatHeader\(/);
  assert.match(toggle, /animateCatBody\(/);
  // Skipping the animation must still change the state, not drop the tap.
  assert.match(toggle, /repaintCategory\(/);
});

test('the slide is clipped while it travels', () => {
  assert.match(INDEX, /\.cat-body-anim \{ overflow: hidden; box-sizing: border-box; \}/);
});

test('a targeted repaint cancels any slide on the section it replaces', () => {
  assert.match(bodyOf('repaintCategory'), /cancelCatAnim\(catId\)/);
});

test('the header matches what renderCategory draws for a collapsed category', () => {
  // The tooltip and count text are the app's existing words, not new ones.
  assert.match(INDEX, /\(collapsed \? 'Expand' : 'Collapse'\) \+ ' this category'/);
  assert.match(INDEX, /checked\.length \+ ' done'/);
});
