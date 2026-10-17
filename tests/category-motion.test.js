// Category cards animate open and closed (issue #72).
//
// The body is never removed on a toggle: it stays mounted and a CSS grid row
// animates 1fr → 0fr over the chevron's .18s ease. These are source-level
// invariants — the browser-side behaviour they pin is exercised by the
// `/?shot=collapsed` checks in dapp.json.
//
// Run with: node --test tests/category-motion.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const INDEX = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

// The function's body, from its declaration to the next top-level helper.
function sourceBetween(start, end) {
  const from = INDEX.indexOf(start);
  assert.notEqual(from, -1, `missing ${start}`);
  return INDEX.slice(from, INDEX.indexOf(end, from));
}

test('the category body transitions its grid row over the chevron timing', () => {
  assert.match(INDEX, /\.cat-body\s*\{[^}]*display:\s*grid;/,
    'the body must be a grid so a row can be interpolated');
  assert.match(INDEX, /\.cat-body\s*\{[^}]*grid-template-rows:\s*1fr;/,
    'an expanded body is one full row');
  assert.match(INDEX, /\.cat-body\s*\{[^}]*transition:\s*grid-template-rows\s+\.18s\s+ease;/,
    'the slide must reuse the chevron’s quick .18s ease');
  assert.match(INDEX, /\.cat-body\s*>\s*\.un-group\s*\{\s*min-height:\s*0;/,
    'without min-height: 0 a 0fr row cannot reach zero height');
  assert.match(INDEX, /\.cat-section\[data-collapsed="1"\]\s+\.cat-body\s*\{\s*grid-template-rows:\s*0fr;/,
    'a collapsed section clips the mounted body to zero height');
});

test('reduced motion disables the body transition', () => {
  assert.match(INDEX,
    /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*\.cat-body\s*\{\s*transition:\s*none;/,
    'reduced motion keeps the instant snap');
});

test('renderCategory mounts the body and records the collapse state', () => {
  const render = sourceBetween('function renderCategory(c) {', 'function repaintCategory(');
  assert.ok(render.includes('data-collapsed="${collapsed ? \'1\' : \'0\'}"'),
    'the section carries the state the CSS keys off');
  assert.ok(render.includes('<div class="cat-body"'),
    'the body wrapper is always rendered, never dropped on collapse');
  assert.ok(render.includes('inert aria-hidden="true"'),
    'a collapsed body is inert and hidden from assistive tech');
  assert.ok(!/\$\{collapsed \? '' : `\s*<div class="un-group">/.test(render),
    'the body must not be conditionally removed, or the slide cannot run');
});

test('toggleCatCollapsed updates the live section instead of repainting', () => {
  const toggle = sourceBetween('function toggleCatCollapsed(catId) {', '// Categories whose');
  assert.ok(!toggle.includes('repaintCategory'),
    'a repaint inserts a final-state node, which never transitions — the card would snap');
  assert.ok(toggle.includes('sec.dataset.collapsed = collapsed ? \'1\' : \'0\''),
    'the live section flips its state so the browser can interpolate from the current height');
  assert.ok(toggle.includes("btn.setAttribute('aria-expanded', String(!collapsed))"),
    'the chevron keeps up with the tap');
  assert.ok(toggle.includes("body.setAttribute('inert', '')") &&
            toggle.includes("body.removeAttribute('inert')"),
    'the mounted body is made inert while closed and reachable again when open');
});

test('collapsed sections are excluded from item reordering', () => {
  const wire = sourceBetween('function wireNative() {', '// --- reorder drop animation');
  assert.match(wire,
    /itemSelector:\s*'\.cat-section:not\(\[data-collapsed="1"\]\) \.un-swipe:has\(\.item-row\), '\s*\+\s*'\.cat-section:not\(\[data-collapsed="1"\]\) \.item-row\.un-swipe, '\s*\+\s*'\.cat-section:not\(\[data-collapsed="1"\]\) \.empty-note'/,
    'hidden rows must not become drop targets or shift drag indices');
});
