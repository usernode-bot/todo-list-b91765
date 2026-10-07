// When a finished category closes: "Hide all completed" (issue #78) and
// checking a category's last open item (issue #79).
//
// Both are decided by the whole-category collapse state in public/index.html:
// a per-list Set holding `id` (collapsed) or `-id` (explicitly kept open), with
// "finished => collapsed" as the default when neither is stored. The functions
// that read and write it are lifted out of index.html by name and run in a vm
// against a fake list, with the DOM-facing helpers stubbed — the same
// source-level approach tests/sw-offline.test.js takes.
//
// Run with: node --test tests/category-collapse.test.js

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
  'showCompleted', 'setShowCompleted', 'isCatFullyDone', 'catShowDone',
  'collapsedSet', 'resetCollapsed', 'persistCollapsed', 'catCollapsed',
  'setCatCollapsed', 'clearKeepOpen', 'toggleItem',
];

// A list with an unfinished category (1) and a finished one (2).
function load() {
  const store = new Map();
  const sandbox = {
    NS: 'todo:',
    SHOW_COMPLETED_KEY: 'todo:showCompleted',
    store,
    current: {
      list: { id: 7 },
      categories: [{ id: 1 }, { id: 2 }],
      items: [
        { id: 10, category_id: 1, checked: false },
        { id: 11, category_id: 1, checked: true },
        { id: 20, category_id: 2, checked: true },
      ],
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
    record() {}, cacheList() {}, repaintCategory() {}, repaintAllCategories() {},
    sectionBottom: () => 99,
  };
  vm.createContext(sandbox);
  // `let collapsedIds` / `const catDoneOverrides` in the page are top-level
  // bindings; here they live on the sandbox so the lifted code sees them.
  vm.runInContext(LIFTED.map(fnSource).join('\n'), sandbox);
  return sandbox;
}

test('a finished category starts collapsed, an unfinished one open', () => {
  const s = load();
  assert.equal(s.catCollapsed(1), false);
  assert.equal(s.catCollapsed(2), true);
});

test('#78: Hide all completed closes finished categories that Show had opened', () => {
  const s = load();
  s.setShowCompleted(true);
  assert.equal(s.catCollapsed(2), false, 'Show all completed opens finished categories');
  s.setShowCompleted(false);
  assert.equal(s.catCollapsed(2), true, 'Hide all completed must close them again');
  assert.equal(s.catCollapsed(1), false, 'an unfinished category is untouched');
});

test('#78: Hide all completed also closes a finished category opened by its chevron', () => {
  const s = load();
  s.setCatCollapsed(2, false);
  s.setShowCompleted(false);
  assert.equal(s.catCollapsed(2), true);
});

test('#78: Hide all completed leaves an unfinished category the user collapsed shut', () => {
  const s = load();
  s.setCatCollapsed(1, true);
  s.setShowCompleted(false);
  assert.equal(s.catCollapsed(1), true);
});

// Issue #93: the last check only closes the category when its done list is
// already hidden — with the completed rows showing, the card stays open.

test('#93: checking the last open item stays open while the done list is shown', () => {
  const s = load();
  assert.equal(s.catCollapsed(1), false);
  s.toggleItem(10, true);
  assert.equal(s.catCollapsed(1), false, 'done list shown (the default): card stays open');
  // The keep-open marker is written and persisted, so a reload keeps the card open.
  assert.deepEqual([...s.store.get('todo:collapsed:7')], [-1]);
  s.resetCollapsed();
  assert.equal(s.catCollapsed(1), false);
});

test('#93: checking the last open item collapses when the done list is hidden', () => {
  const s = load();
  s.rawSet('todo:showCompleted', 'false'); // global show-completed off
  assert.equal(s.catShowDone(1), false);
  s.toggleItem(10, true);
  assert.equal(s.catCollapsed(1), true);
});

test('#93: the per-category "N done" divider counts as the done list too', () => {
  const s = load();
  s.catDoneOverrides[1] = false; // divider folded for this category only
  s.toggleItem(10, true);
  assert.equal(s.catCollapsed(1), true);
});

test('#93: an explicit keep-open marker survives the last tick while done is shown', () => {
  const s = load();
  s.setShowCompleted(true);
  s.setCatCollapsed(1, false); // what toggleCatCollapsed does on a header tap
  s.toggleItem(10, true);
  assert.equal(s.catCollapsed(1), false);
});

test('#93: an explicit keep-open marker is still dropped when the done list is hidden', () => {
  const s = load();
  s.catDoneOverrides[1] = false;
  s.setCatCollapsed(1, false);
  s.toggleItem(10, true);
  assert.equal(s.catCollapsed(1), true);
});

test('#79: checking an item that leaves others open does not collapse', () => {
  const s = load();
  s.current.items.push({ id: 12, category_id: 1, checked: false });
  s.toggleItem(10, true);
  assert.equal(s.catCollapsed(1), false);
  // No marker either way: the state is untouched.
  assert.equal(s.store.get('todo:collapsed:7'), undefined);
});

test('#79: unchecking (or undoing) returns the category to its open default', () => {
  // Done list shown: the tick wrote a keep-open marker, unchecking lands the
  // category on its open default anyway.
  const s = load();
  s.toggleItem(10, true);
  s.toggleItem(10, false);
  assert.equal(s.catCollapsed(1), false);
  // Done list hidden: the tick collapsed the card, unchecking reopens it.
  const t = load();
  t.catDoneOverrides[1] = false;
  t.toggleItem(10, true);
  assert.equal(t.catCollapsed(1), true);
  t.toggleItem(10, false);
  assert.equal(t.catCollapsed(1), false);
});

test('#79: a finished category can still be expanded by hand afterwards', () => {
  const s = load();
  s.catDoneOverrides[1] = false; // tick collapses when the done list is hidden
  s.toggleItem(10, true);
  s.setCatCollapsed(1, false); // what toggleCatCollapsed does on a header tap
  assert.equal(s.catCollapsed(1), false);
});

test('the collapse state is persisted per list', () => {
  const s = load();
  s.setShowCompleted(true);
  s.setShowCompleted(false);
  s.toggleItem(10, true);
  s.resetCollapsed();
  assert.equal(s.catCollapsed(1), true);
  assert.equal(s.catCollapsed(2), true);
  assert.deepEqual([...s.store.get('todo:collapsed:7')], []);
});
