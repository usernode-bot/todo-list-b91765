// The category body slide (issue #72) is decoration in the same template as the
// header chevron, so the pair is pinned here: the body must keep drawing while
// it slides shut, and it must borrow the chevron's own beat so the two read as
// one motion. Measuring real motion needs a browser, which these tests don't
// have; what they guard is that the wiring the motion depends on can't be
// dropped by a later edit without a failure.
//
// Run with: node --test tests/category-collapse-animation.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

// The body of a top-level function in the template, so an assertion can't be
// satisfied by an unrelated mention elsewhere in the file.
function fnSource(name) {
  const start = INDEX.indexOf('function ' + name + '(');
  assert.ok(start > -1, 'function ' + name + ' is missing');
  const next = INDEX.indexOf('\n    function ', start + 1);
  return INDEX.slice(start, next > -1 ? next : undefined);
}

test('the body slide keeps the chevron beat', () => {
  assert.match(INDEX, /\.cat-head \.chev \{[^}]*transition: transform \.18s ease;/);
  assert.match(INDEX, /const CAT_BODY_MS = 180;/);
  assert.match(INDEX, /const CAT_BODY_EASE = 'ease';/);
  assert.match(fnSource('slideCatBody'), /duration: CAT_BODY_MS/);
  assert.match(fnSource('slideCatBody'), /easing: CAT_BODY_EASE/);
});

test('reduced motion and browsers without WAAPI snap', () => {
  const src = fnSource('canSlideCatBody');
  assert.match(
    src,
    /return !prefersReducedMotion\(\) && typeof Element\.prototype\.animate === 'function';/,
  );
  // The slide is only ever started behind that guard.
  assert.match(fnSource('toggleCatCollapsed'), /if \(slide\) slideCatBody\(/);
});

test('a collapsing card draws its body until the slide finishes', () => {
  const renderSrc = INDEX.slice(
    INDEX.indexOf('function renderCategory'),
    INDEX.indexOf('function renderItem'),
  );
  assert.match(renderSrc, /const closingH = collapsed \? catClosingHeight\(c\.id\) : null;/);
  assert.match(renderSrc, /const bodyShown = !collapsed \|\| closingH != null;/);
  assert.match(renderSrc, /\$\{bodyShown \? `\s*<div class="un-group"\$\{closingH != null/);

  // The header and the collapsed count go live at once: the repaint happens
  // before the slide starts.
  const toggleSrc = fnSource('toggleCatCollapsed');
  const repaintAt = toggleSrc.indexOf('repaintCategory(catId)');
  const slideAt = toggleSrc.indexOf('slideCatBody(id, collapsing, fromHeight)');
  assert.ok(repaintAt > -1 && slideAt > -1, 'toggleCatCollapsed must repaint and slide');
  assert.ok(repaintAt < slideAt, 'the repaint must land before the slide starts');
});
