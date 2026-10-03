// Checked items keep their place in the list (issue #75): checking or
// unchecking an item must not move it — not on the server, and not in the
// optimistic local state the row is drawn from.
//
// Like tests/category-collapse.test.js, this lifts the functions out of
// public/index.html by name and runs them in a vm against a fake list with
// the DOM-facing helpers stubbed. It would have caught the old behaviour
// (toggling re-projected sort_order onto the bottom of the row's new section):
// with that code the sort_order assertions below fail.
//
// Run with: node --test tests/checked-in-place.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// The source of `function name(...) { ... }`, found by brace matching. None of
// the functions lifted here hold a brace inside a string or regex.
function fnSource(name) {
  const start = INDEX.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `index.html should define ${name}()`);
  let i = INDEX.indexOf('{', INDEX.indexOf(')', start));
  let depth = 0;
  for (; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

const LIFTED = [
  'isCatFullyDone', 'collapsedSet', 'resetCollapsed', 'persistCollapsed',
  'catCollapsed', 'setCatCollapsed', 'clearKeepOpen', 'toggleItem', 'localNewItem',
  'itemOrder', 'listItems', 'sectionItems', 'renderCategory', 'renderItem',
  'esc', 'todayISO', 'nowHM', 'isOverdue', 'displayCategories', 'showCompleted',
  'catShowDone',
];

function load(items) {
  const store = new Map();
  const sandbox = {
    NS: 'todo:',
    SHOW_COMPLETED_KEY: 'todo:showCompleted',
    store,
    current: {
      list: { id: 7 },
      categories: [{ id: 1 }],
      items,
    },
    me: 'evan',
    catDoneOverrides: {},
    collapsedKey: listId => 'todo:collapsed:' + listId,
    collapsedIds: null,
    rawGet: k => store.get(k),
    rawSet: (k, v) => store.set(k, v),
    cacheGet: k => store.get(k),
    cacheSet: (k, v) => store.set(k, v),
    commit: () => true,
    record() {}, cacheList() {}, repaintCategory() {},
    datesOn: () => false,
    searchActive: () => false,
    searchQ: () => '',
    pendingShown: false,
    pendingItemIds: () => new Set(),
    openAdders: new Set(),
    // Only meaningful to the pre-#75 code, which moved a toggled row to the
    // bottom of its section; kept so this suite fails loudly on a revert.
    sectionBottom: () => 99,
  };
  vm.createContext(sandbox);
  vm.runInContext(LIFTED.map(fnSource).join('\n'), sandbox);
  return sandbox;
}

test('#75: checking an item leaves its sort_order alone', () => {
  const s = load([
    { id: 10, category_id: 1, checked: false, sort_order: 2 },
    { id: 11, category_id: 1, checked: true, sort_order: 1 },
  ]);
  s.toggleItem(10, true);
  const item = s.current.items.find(i => i.id === 10);
  assert.equal(item.checked, true, 'the item is checked');
  assert.equal(item.sort_order, 2, 'its position is unchanged');
  assert.ok(item.completed_at, 'completion time is still recorded');
  assert.equal(item.last_checked_by, 'evan');
});

test('#75: unchecking an item leaves its sort_order alone too', () => {
  const s = load([
    { id: 10, category_id: 1, checked: false, sort_order: 2 },
    { id: 11, category_id: 1, checked: true, sort_order: 1 },
  ]);
  s.toggleItem(11, false);
  const item = s.current.items.find(i => i.id === 11);
  assert.equal(item.checked, false);
  assert.equal(item.sort_order, 1, 'its position is unchanged');
  assert.equal(item.completed_at, null);
});

test('#75: a new item lands on top of the whole category, done rows included', () => {
  const s = load([]);
  // The checked row holds the category's smallest sort_order here — the
  // normal shape after a few top-of-list adds — and the old
  // top-of-the-unchecked-section insert ignored it and landed below.
  const item = s.localNewItem(99, 1, 'Milk', [
    { id: 1, category_id: 1, checked: true, sort_order: 0 },
    { id: 2, category_id: 1, checked: false, sort_order: 5 },
  ]);
  assert.equal(item.sort_order, -1, 'above every row of the category');
  assert.equal(item.checked, false);
  assert.equal(item.category_id, 1);
  assert.equal(item.text, 'Milk');
});

// --- rendering ---------------------------------------------------------------
// One sequence per category: the done row renders where it sits (struck
// through), inside the same .cat-items container as the open rows, with the
// "N done" toggle demoted to the card's footer row.

function itemIds(html) {
  return [...html.matchAll(/data-item="(\d+)"/g)].map(m => +m[1]);
}

test('#75: a checked row renders in place, struck through, in the shared sequence', () => {
  const s = load([
    { id: 10, category_id: 1, checked: false, sort_order: 1, text: 'First' },
    { id: 11, category_id: 1, checked: true, sort_order: 2, text: 'Middle', completed_at: '2026-01-01' },
    { id: 12, category_id: 1, checked: false, sort_order: 3, text: 'Last' },
  ]);
  const html = s.renderCategory({ id: 1, name: 'General' });
  assert.ok(html.includes('class="cat-items"'), 'the category body renders');
  assert.ok(!html.includes('done-items'), 'the separate done lane is gone');
  // Done row sits between its neighbours, in one sequence.
  assert.deepEqual(itemIds(html), [10, 11, 12]);
  const row = html.slice(html.indexOf('data-item="11"'), html.indexOf('data-item="12"'));
  assert.ok(row.includes('data-checked="1"'), 'marked done');
  assert.ok(row.includes('line-through'), 'struck through');
  // The done-toggle is now the card's footer row, after the items.
  assert.ok(html.indexOf('toggleCatDone(1)') > html.indexOf('data-item="11"'),
    'the done-toggle renders after the in-place done row');
  assert.match(html, />1 done</);
});

test("#75: a category's hidden completed rows leave the footer toggle in place", () => {
  const s = load([
    { id: 10, category_id: 1, checked: false, sort_order: 1, text: 'First' },
    { id: 11, category_id: 1, checked: true, sort_order: 2, text: 'Middle', completed_at: '2026-01-01' },
    { id: 12, category_id: 1, checked: false, sort_order: 3, text: 'Last' },
  ]);
  s.catDoneOverrides[1] = false; // what the footer toggle's Hide does
  const html = s.renderCategory({ id: 1, name: 'General' });
  assert.deepEqual(itemIds(html), [10, 12], 'the done row is hidden');
  assert.match(html, /toggleCatDone\(1\)/, 'but the footer toggle stays');
});

test('#75: a finished category keeps its drop row and its done row in one sequence', () => {
  const s = load([
    { id: 11, category_id: 1, checked: true, sort_order: 1, text: 'Only', completed_at: '2026-01-01' },
  ]);
  s.setCatCollapsed(1, false); // what loadShotDrop and the chevron do
  const html = s.renderCategory({ id: 1, name: 'General' });
  assert.match(html, /empty-note done-note/, 'the drop row stays');
  assert.deepEqual(itemIds(html), [11], 'the done row renders beside it');
  assert.match(html, />1 done</);
});
