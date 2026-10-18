// Issue #72 — the category card body slides open/closed instead of snapping.
// The animation lives in the page's inline script (it animates the live
// re-rendered body), so these assertions pin the pieces of that wiring: the
// shared .18s timing the chevron already uses, the reduced-motion opt-out,
// and the toggle routing through the animator. Each fails on a page where
// the toggle still only setCatCollapsed + repaintCategory.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'index.html'),
  'utf8'
);

test('the category body carries a slide transition on the chevron timing', () => {
  const css = html.match(/\.cat-body-anim\s*\{[^}]*\}/);
  assert.ok(css, '.cat-body-anim rule exists');
  assert.match(css[0], /transition:\s*height \.18s ease/, 'mirrors the chevron .18s ease');
  assert.match(css[0], /overflow:\s*hidden/, 'clips while the height animates');
});

test('the slide opts out under prefers-reduced-motion', () => {
  assert.match(
    html,
    /@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.cat-body-anim\s*\{\s*transition:\s*none;?\s*\}\s*\}/
  );
});

test('the category toggle animates instead of only repainting', () => {
  // toggleCatCollapsed must hand off to the animator, and the animator must
  // bail to the snap when the visitor prefers reduced motion.
  const toggle = html.match(/function toggleCatCollapsed\(catId\) \{[\s\S]*?\n    \}/);
  assert.ok(toggle, 'toggleCatCollapsed exists');
  assert.match(toggle[0], /animateCatToggle\(catId, opening\)/);
  const animator = html.match(/function animateCatToggle\(catId, opening\) \{[\s\S]*?\n    \}/);
  assert.ok(animator, 'animateCatToggle exists');
  assert.match(animator[0], /prefersReducedMotion\(\) && return false|if \(prefersReducedMotion\(\)\) return false;/);
});
