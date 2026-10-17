// Issue #72: category bodies slide open/closed instead of snapping.
//
// The animation is invisible to a headless navigation check, so what is
// pinned here are the one-way doors the change could reopen: every collapse
// path that is NOT a tap on the header (the adder's auto-expand, the global
// "Show all completed" loop, the ?shot loaders) must keep its plain instant
// repaint, and the tap path must keep the reduced-motion / WAAPI guards that
// the reorder FLIP pass already established.
//
// Run with: node --test tests/cat-animation.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
// server.js substitutes the platform's origin into index.html at boot, so the
// test reads it the same way — the raw template is not what any browser runs.
const INDEX = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8')
  .split('__USERNODE_PLATFORM_ORIGIN__').join('https://platform.example');

// Slice a function's source out of the inline script by brace matching from
// its signature. Safe here: these bodies contain no brace characters inside
// string or template literals.
function fnBody(name) {
  const sig = 'function ' + name + '(';
  const start = INDEX.indexOf(sig);
  assert.notEqual(start, -1, 'expected an inline function ' + name + '()');
  let depth = 0, end = -1;
  for (let i = INDEX.indexOf('{', start); i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.notEqual(end, -1, 'expected ' + name + '() to have a balanced body');
  return INDEX.slice(start, end + 1);
}

test('a tap on the header goes through the slide helper, not a plain repaint', () => {
  const fn = fnBody('toggleCatCollapsed');
  assert.match(fn, /animateCatToggle\(/, 'the tap path must animate');
  assert.doesNotMatch(fn, /repaintCategory|repaintAllCategories/,
    'the tap path must not repaint directly — the helper owns that');
});

test('the collapse paths that are not taps stay instant', () => {
  // Auto-expand from the adder: the input must be focusable in place at once.
  const adder = fnBody('toggleAdder');
  assert.match(adder, /setCatCollapsed\(catId, false\)/);
  assert.match(adder, /repaintCategory\(catId\)/);
  assert.doesNotMatch(adder, /animateCatToggle/);

  // "Show all completed" resetting finished categories: a bulk state change.
  const show = fnBody('setShowCompleted');
  assert.match(show, /setCatCollapsed\(c\.id, false\)/);
  assert.match(show, /repaintAllCategories\(\)/);
  assert.doesNotMatch(show, /animateCatToggle/);

  // Screenshot deep links render the already-decided final state.
  for (const name of ['loadShotCollapsed', 'loadShotDrop']) {
    const fn = fnBody(name);
    assert.match(fn, /setCatCollapsed\(target\.id/);
    assert.match(fn, /repaintAllCategories\(\)/);
    assert.doesNotMatch(fn, /animateCatToggle/);
  }
});

test('the slide keeps the reduced-motion and WAAPI guards, snapping as fallback', () => {
  const fn = fnBody('animateCatToggle');
  // Same guard pattern as the reorder FLIP pass.
  assert.match(fn, /prefersReducedMotion\(\)/);
  assert.match(fn, /typeof Element\.prototype\.animate !== 'function'/);
  // The guarded branch (and any degenerate one) falls back to today's snap.
  assert.match(fn, /repaintCategory\(catId\)/);
});

test('ghost rows of a closing body are marked wired before insertion', () => {
  const fn = fnBody('animateCatToggle');
  assert.match(fn, /data-wired/,
    'a wireNative() pass during the 180ms window must not wire ghost rows');
});

test('the slide borrows the chevron\'s declared timing', () => {
  const chev = INDEX.match(/\.cat-head \.chev \{[^}]*transition: transform ([\d.]+)s (\w+)/);
  assert.ok(chev, 'expected the chevron\'s transition in the CSS');
  const ms = INDEX.match(/const CAT_TOGGLE_MS = (\d+)/);
  const ease = INDEX.match(/const CAT_TOGGLE_EASE = '(\w+)'/);
  assert.ok(ms && ease, 'expected CAT_TOGGLE_MS / CAT_TOGGLE_EASE constants');
  assert.equal(+ms[1], Math.round(parseFloat(chev[1]) * 1000),
    'the body slide must run at the chevron\'s duration');
  assert.equal(ease[1], chev[2], 'the body slide must use the chevron\'s easing');
});