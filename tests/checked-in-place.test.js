// Checked items keep their rank within their section (issue #75): checking or
// unchecking an item must not move it WITHIN its section — not on the server,
// and not in the optimistic local state the row is drawn from. The two
// sections (open / completed) still render as separate lists, as before.
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
  let start = INDEX.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `index.html should define ${name}()`);
  // Keep a preceding `async` — slicing from `function` alone would drop it
  // and leave the body's `await`s invalid.
  if (INDEX.slice(start - 6, start) === 'async ') start -= 6;
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
  'itemOrder', 'sectionItems', 'renderCategory', 'renderItem',
  'esc', 'todayISO', 'nowHM', 'isOverdue', 'displayCategories', 'showCompleted',
  'catShowDone', 'firstListWhere', 'loadShotPending',
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

test('#75: uncheck then recheck returns the item to its rank in the completed section', () => {
  // The user's own example: tofu at the TOP of the completed section. Its
  // sort_order interleaves with the open items' (that is normal now), so the
  // old append-to-the-end toggle would demote it to last on recheck.
  const s = load([
    { id: 1, category_id: 1, checked: false, sort_order: 1, text: 'Milk' },
    { id: 2, category_id: 1, checked: true, sort_order: 2, text: 'Tofu' },
    { id: 3, category_id: 1, checked: true, sort_order: 4, text: 'Bread' },
    { id: 4, category_id: 1, checked: false, sort_order: 3, text: 'Eggs' },
  ]);
  const rankOf = () => s.sectionItems(1, true).map(i => i.id);
  assert.deepEqual(rankOf(), [2, 3], 'tofu starts on top of the completed section');
  s.toggleItem(2, false);
  assert.deepEqual(s.sectionItems(1, false).map(i => i.text),
    ['Milk', 'Tofu', 'Eggs'], 'unchecking files it among the open items by rank');
  s.toggleItem(2, true);
  assert.deepEqual(rankOf(), [2, 3], 'rechecking returns tofu to the top, not the end');
});

test('#75: a new item lands on top of the open section, done rows included', () => {
  const s = load([]);
  // The checked row holds the category's smallest sort_order here — the
  // normal shape after a few top-of-list adds and reorders — so a new item
  // must land ABOVE it to be first in the open section.
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
// The category renders as two separate sections again: an open-items lane and
// (behind the "N done" toggle) a completed-items lane, each in its own order.

function itemIds(html) {
  return [...html.matchAll(/data-item="(\d+)"/g)].map(m => +m[1]);
}

// One category is rendered per call, and the lanes appear in a fixed order:
// active lane, "N done" toggle, done lane. Slice between those markers.
function laneIds(html, lane) {
  const marker = lane === 'active' ? 'class="active-items' : 'class="done-items"';
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const toggle = html.indexOf('toggleCatDone(1)');
  const sectionEnd = html.indexOf('</section>');
  const end = lane === 'active'
    ? (toggle !== -1 ? toggle : sectionEnd)
    : sectionEnd;
  return itemIds(html.slice(start, end));
}

test('#75: a checked row renders in its own completed lane, struck through', () => {
  const s = load([
    { id: 10, category_id: 1, checked: false, sort_order: 1, text: 'First' },
    { id: 11, category_id: 1, checked: true, sort_order: 2, text: 'Middle', completed_at: '2026-01-01' },
    { id: 12, category_id: 1, checked: false, sort_order: 3, text: 'Last' },
  ]);
  const html = s.renderCategory({ id: 1, name: 'General' });
  assert.ok(html.includes('class="active-items'), 'the open lane renders');
  assert.deepEqual(laneIds(html, 'active'), [10, 12], 'only open rows in the open lane');
  assert.deepEqual(laneIds(html, 'done'), [11], 'the completed row in the completed lane');
  const row = html.slice(html.indexOf('data-item="11"'), html.indexOf('</section>'));
  assert.ok(row.includes('data-checked="1"'), 'marked done');
  assert.ok(row.includes('line-through'), 'struck through');
  // The "N done" toggle sits between the two lanes.
  assert.ok(html.indexOf('toggleCatDone(1)') > html.indexOf('data-item="12"'),
    'the toggle renders after the open lane');
  assert.ok(html.indexOf('toggleCatDone(1)') < html.indexOf('class="done-items"'),
    'and before the completed lane');
  assert.match(html, />1 done</);
});

test("#75: a category's hidden completed rows leave the toggle in place", () => {
  const s = load([
    { id: 10, category_id: 1, checked: false, sort_order: 1, text: 'First' },
    { id: 11, category_id: 1, checked: true, sort_order: 2, text: 'Middle', completed_at: '2026-01-01' },
    { id: 12, category_id: 1, checked: false, sort_order: 3, text: 'Last' },
  ]);
  s.catDoneOverrides[1] = false; // what the "N done" toggle's Hide does
  const html = s.renderCategory({ id: 1, name: 'General' });
  assert.deepEqual(laneIds(html, 'active'), [10, 12]);
  assert.equal(laneIds(html, 'done'), null, 'the completed lane is not rendered');
  assert.match(html, /toggleCatDone\(1\)/, 'but the toggle stays');
});

test('#75: a finished category keeps its drop lane and its completed lane', () => {
  const s = load([
    { id: 11, category_id: 1, checked: true, sort_order: 1, text: 'Only', completed_at: '2026-01-01' },
  ]);
  s.setCatCollapsed(1, false); // what loadShotDrop and the chevron do
  const html = s.renderCategory({ id: 1, name: 'General' });
  assert.match(html, /empty-note done-note/, 'the drop row stays in the open lane');
  assert.deepEqual(laneIds(html, 'active'), [], 'the open lane is empty but present');
  assert.deepEqual(laneIds(html, 'done'), [11], 'the completed row in the completed lane');
  assert.match(html, />1 done</);
});

// --- the ?shot=pending route ---------------------------------------------------
// The route must open a list that actually has a completed section to show:
// Home orders newest-first and the newest demo list has nothing ticked, so the
// old plain "first list" pick rendered no done lane and the staging check
// found nothing.

test('the pending shot route picks a list that also shows a completed section', async () => {
  const s = load([]);
  s.api = async p => {
    if (p === '/api/lists') {
      return { lists: [{ id: 3, name: 'Demo: Due Dates' }, { id: 1, name: 'Demo: Weekend Plans' }] };
    }
    if (p === '/api/lists/3') {
      return { list: { id: 3 }, items: [{ id: 30, category_id: 1, checked: false, sort_order: 1 }] };
    }
    return { list: { id: 1 }, items: [
      { id: 10, category_id: 1, checked: false, sort_order: 1 },
      { id: 11, category_id: 1, checked: true, sort_order: 2 },
    ] };
  };
  s.loadedId = null;
  s.loadList = async id => {
    s.loadedId = id;
    const d = await s.api('/api/lists/' + id);
    s.current = { list: d.list, categories: d.categories || [], items: d.items };
  };
  s.loadHome = async () => { s.loadedId = 'home'; };
  s.repaintAllCategories = () => {};
  await s.loadShotPending();
  assert.equal(s.loadedId, 1, 'it loads the list with both open and completed rows');
  assert.ok(s.current.items.some(i => i.checked), 'the opened list has a completed row to render');
  assert.ok(s.shotPendingIds.has(10), 'the pending marker goes on an open row');
});
