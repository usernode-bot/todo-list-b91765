// The ?shot=due harness opens a list that actually shows due dates (issue
// #97's own regression): since dates are on for every list, the old pick
// ("the first list with the flag set") lands on the newest list, which holds
// no dated items, and the shot would show "+ date" buttons and no chips. The
// harness now probes the candidates and opens the first one carrying a dated
// item, falling back to the old pick when none does.
//
// Like tests/checked-in-place.test.js, this lifts the function out of
// public/index.html and runs it in a vm against stubbed helpers.
//
// Run with: node --test tests/due-shot-pick.test.js

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

// The staging-like shape after #97 and #109: Home returns newest first and the
// one-time backfill has every list's dates on, but the older "Demo: Due Dates"
// list is the ordinary list holding dated items. The newest list is the daily
// demo list, which holds dated items too but folds its older days away.
// Fresh copies per load(), so a test's edits (the "no dated list anywhere"
// case) never leak into another.
function fixtures() {
  const lists = [
    { id: 5, name: 'Demo: Daily', due_dates_enabled: true, daily_enabled: true },
    { id: 4, name: 'Demo: Shared Remnants', due_dates_enabled: true },
    { id: 3, name: 'Demo: Due Dates', due_dates_enabled: true },
    { id: 2, name: 'Demo: Shared Errands', due_dates_enabled: true },
  ];
  const data = {
    5: { list: lists[0], items: [{ id: 0, text: 'Reply to Sam', due_date: '2026-10-23' }] },
    4: { list: lists[1], items: [{ id: 1, text: 'Borrow the good marker', due_date: null }] },
    3: { list: lists[2], items: [
      { id: 2, text: 'Call the dentist', due_date: '2026-10-17' },
      { id: 4, text: 'Grocery run', due_date: '2026-10-24', repeat_rule: 'weekly' },
    ] },
    2: { list: lists[3], items: [{ id: 3, text: 'Pick up dry cleaning', due_date: null }] },
  };
  return { lists, data };
}

function load(opts = {}) {
  let { lists, data } = fixtures();
  if (!opts.dated) data[3].items.forEach(i => { i.due_date = null; }); // nothing dated anywhere
  // A viewer whose only list is the daily one: the shot still has to open
  // something rather than fall through to Home.
  if (opts.onlyDaily) lists = lists.filter(l => l.daily_enabled);
  const sandbox = {
    api: async (url) => {
      if (url === '/api/lists') return { lists };
      const id = Number(url.split('/').pop());
      return data[id];
    },
    loadHome: async () => { sandbox.openedHome = true; },
    loadList: async (id) => {
      sandbox.openedListId = id;
      sandbox.current = { list: { ...data[id].list }, items: [...data[id].items] };
    },
    current: null,
    datesOn: () => true, // the backfill leaves every staging list's dates on
    renderList() {},
    shotDueEditor: false,
    openDueEditor() { sandbox.openedEditor = true; },
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource('loadShotDue'), sandbox);
  return sandbox;
}

test('#97: the due shot opens a list that actually holds a dated item', async () => {
  const s = load({ dated: true });
  await s.loadShotDue();
  assert.equal(s.openedListId, 3, 'the newest list is skipped for the dated one');
  assert.ok(!s.openedHome, 'Home is never opened when a list exists');
});

test('#109: a daily list never takes over the due shot', async () => {
  // The daily demo list is the newest and holds dated items, so the probe
  // would land on it and show a daily view (its ticked earlier days folded
  // away) instead of the plain dated list the shot is about.
  const s = load({ dated: true });
  await s.loadShotDue();
  assert.equal(s.openedListId, 3, 'the daily list is skipped for the ordinary one');
  assert.equal(s.current.list.daily_enabled, undefined,
    'the list the due shot opens is an ordinary one');
});

test('#109: a daily list is used only when no ordinary list exists', async () => {
  const s = load({ dated: true, onlyDaily: true });
  await s.loadShotDue();
  assert.equal(s.openedListId, 5, 'the daily list opens rather than Home');
  assert.ok(!s.openedHome);
});

test('#97: with no dated list anywhere, the shot keeps the old pick', async () => {
  const s = load({ dated: false });
  await s.loadShotDue();
  assert.equal(s.openedListId, 4, 'the first list with dates on opens as before');
  assert.ok(!s.openedHome, 'Home is never opened when a list exists');
});