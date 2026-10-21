// Category open/close is animated (issue #72), not snapped.
//
// The animation lives in public/index.html and only runs in a browser, so the
// things that can silently regress are pinned at the source level:
//
//   - the slide's duration drifting away from the chevron's .18s, which would
//     break the "one motion" feel the issue asks for;
//   - the slide animating something other than height (a fade, a scale), or
//     the collapsed body becoming permanently present in the markup — which
//     would turn collapsed rows into drag and swipe targets, because the kit's
//     reorder and swipe selectors span #cats;
//   - the instant fallback quietly disappearing, so reduced-motion users and
//     browsers without Element.animate lose the toggle instead of snapping.
//
// Run with: node --test tests/category-animation.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
// server.js substitutes the platform's origin into index.html at boot.
const INDEX = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8')
  .split('__USERNODE_PLATFORM_ORIGIN__').join('https://platform.example');

const START = '// --- category open/close animation (issue #72) ---';
const END = '// --- end category open/close animation ---';

function animBlock() {
  const from = INDEX.indexOf(START);
  const to = INDEX.indexOf(END);
  assert.ok(from !== -1, 'the animation block start marker is present');
  assert.ok(to > from, 'the animation block end marker follows its start');
  return INDEX.slice(from, to);
}

test('the slide lasts exactly as long as the chevron rotation', () => {
  const rule = INDEX.match(/\.cat-head\s+\.chev\s*\{[^}]*transition:\s*transform\s+([\d.]+)s\s+ease[^}]*\}/);
  assert.ok(rule, '.cat-head .chev still transitions transform');
  const chevMs = Math.round(parseFloat(rule[1]) * 1000);

  const ms = INDEX.match(/const CAT_ANIM_MS = (\d+);/);
  assert.ok(ms, 'CAT_ANIM_MS is declared next to the animation');
  assert.equal(Number(ms[1]), chevMs,
    'the body and the chevron move on one beat');
});

test('the slide animates the body height', () => {
  const block = animBlock();
  assert.ok(block.includes('.animate('), 'uses the Web Animations API');
  assert.ok(/height:/.test(block), 'the keyframes animate height');
  assert.ok(block.includes('CAT_ANIM_MS'), 'the animation uses the shared duration');
  assert.ok(block.includes('catAnimations.set'), 'the running animation is tracked per category');
  assert.ok(block.includes('renderCategory(c, !opening)'),
    'a closing render keeps the body in the markup so it has something to slide');
});

test('reduced motion, no Web Animations and a detached section all snap as before', () => {
  const block = animBlock();
  assert.ok(block.includes('prefersReducedMotion()'), 'honours reduced motion');
  assert.ok(block.includes('Element.prototype.animate'),
    'falls back when the API is missing');
  assert.ok(block.includes('repaintCategory(catId)'),
    'the fallback is today\'s instant repaint');
});

test('the steady-state markup is unchanged: a collapsed body is not in the DOM', () => {
  assert.ok(INDEX.includes('function renderCategory(c, keepBody)'),
    'the render takes an optional keepBody');
  assert.ok(INDEX.includes('${collapsed && !keepBody ? \'\' : `'),
    'the body is still emitted from the collapsed flag, not kept permanently');
  assert.ok(/function repaintCategory\(catId\)[\s\S]*?el\.outerHTML = renderCategory\(c\);/
    .test(INDEX), 'repaintCategory still renders one argument and so never keeps a body');
  assert.ok(INDEX.includes('map(c => renderCategory(c))'),
    'renderCats still renders one argument and so never keeps a body');
});

test('the motion carries no new CSS', () => {
  assert.ok(!/transition:\s*height/.test(INDEX), 'no CSS height transition');
  assert.ok(!/@keyframes[^{]*\{[\s\S]{0,200}\.un-group/.test(INDEX),
    'no keyframes styling the category body');
});
