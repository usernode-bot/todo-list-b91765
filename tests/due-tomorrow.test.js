// One tap on a task moves it to tomorrow (issue #99): each open task on a
// list with due dates on gets a small "Tomorrow" button beside its date pill.
// Tapping it calls the same applyDue path as the due-date editor, so the time
// is kept, undo works, and it syncs offline like every other due change.
//
// Like tests/checked-in-place.test.js, this lifts the functions out of
// public/index.html by name and runs them in a vm against a fake list with
// the DOM-facing helpers stubbed.

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

// deepStrictEqual compares prototypes, and objects built inside the vm carry
// the vm realm's Object.prototype — spread them into this realm's plain
// objects before comparing.
const plain = o => ({ ...o });

const LIFTED = [
  'esc', 'todayISO', 'tomorrowISO', 'nowHM', 'parseISODate', 'fmtDueTime',
  'dueLabel', 'isOverdue', 'applyDue', 'dueTomorrow', 'renderItem',
];

// A Date whose no-argument constructor reads as a fixed wall-clock moment
// (noon local, away from any DST edge); constructed with args it behaves
// normally, so parseISODate still works.
function fakeDateAt(y, m, d) {
  return class extends Date {
    constructor(...args) { super(args.length ? args[0] : new Date(y, m, d, 12)); }
  };
}

function load(items, opts = {}) {
  const commits = [];
  const records = [];
  const sandbox = {
    current: {
      list: { id: 7, due_dates_enabled: opts.dueDates !== false },
      categories: [{ id: 1 }],
      items,
    },
    LOCALE: undefined,
    BTN_SOFT: 'bg-[var(--fill)] text-[color:var(--label)]',
    commits,
    records,
    commit: op => { commits.push(op); return true; },
    record: entry => records.push(entry),
    cacheList() {},
    repaintCategory() {},
    datesOn: () => !!(sandbox.current && sandbox.current.list.due_dates_enabled),
    searchActive: () => false,
    pendingShown: false,
    pendingItemIds: () => new Set(),
    Date: opts.now ? fakeDateAt(...opts.now) : Date,
  };
  vm.createContext(sandbox);
  vm.runInContext(LIFTED.map(fnSource).join('\n'), sandbox);
  return sandbox;
}

test('#99: tomorrowISO rolls over the month and the year', () => {
  const s = load([], { now: [2026, 11, 31] });
  assert.equal(s.tomorrowISO(), '2027-01-01');
  const s2 = load([], { now: [2026, 1, 28] });
  assert.equal(s2.tomorrowISO(), '2026-03-01', '2026 is not a leap year');
});

test('#99: dueTomorrow moves an item to tomorrow and keeps its time', () => {
  const s = load([{ id: 10, category_id: 1, checked: false, due_date: '2026-10-17', due_time: '09:30' }],
                 { now: [2026, 9, 17] });
  s.dueTomorrow(10);
  const item = s.current.items.find(i => i.id === 10);
  assert.equal(item.due_date, '2026-10-18', 'due date is tomorrow');
  assert.equal(item.due_time, '09:30', 'the time is kept');
  assert.equal(s.commits.length, 1, 'one change queued');
  assert.equal(s.commits[0].method, 'PATCH');
  assert.equal(s.commits[0].path, '/api/items/10');
  // #102: applyDue's body and undo payload now carry repeat_rule too (null
  // when the item doesn't repeat) — the shape the server's PATCH validates.
  assert.deepEqual(plain(s.commits[0].body),
    { due_date: '2026-10-18', due_time: '09:30', repeat_rule: null });
  assert.equal(s.records[0].kind, 'due', 'recorded for undo');
  assert.deepEqual(plain(s.records[0].before),
    { due_date: '2026-10-17', due_time: '09:30', repeat_rule: null },
    'undo holds the old date and time');
});

test('#99: dueTomorrow gives a dateless item tomorrow with no time', () => {
  const s = load([{ id: 11, category_id: 1, checked: false }], { now: [2026, 9, 17] });
  s.dueTomorrow(11);
  const item = s.current.items.find(i => i.id === 11);
  assert.deepEqual(plain(item), { id: 11, category_id: 1, checked: false,
    due_date: '2026-10-18', due_time: null, repeat_rule: null });
});

test('#99: dueTomorrow ignores a checked item', () => {
  const s = load([{ id: 12, category_id: 1, checked: true, due_date: '2026-10-17', due_time: '09:30' }],
                 { now: [2026, 9, 17] });
  s.dueTomorrow(12);
  assert.equal(s.commits.length, 0, 'nothing queued');
  const item = s.current.items.find(i => i.id === 12);
  assert.equal(item.due_date, '2026-10-17', 'the item is untouched');
});

test('#99: the Tomorrow button renders on an open row of a dated list', () => {
  const s = load([
    { id: 10, category_id: 1, checked: false, text: 'Milk', due_date: '2026-10-17' },
    { id: 11, category_id: 1, checked: false, text: 'Bread' },
  ], { now: [2026, 9, 17] });
  const html = s.renderItem(s.current.items[0]);
  assert.match(html, /due-tomorrow/, 'the button renders beside the date pill');
  assert.match(html, />Tomorrow</, 'labelled Tomorrow');
  assert.match(html, /dueTomorrow\(rowId\(this\)\)/, 'wired to dueTomorrow');
  const html2 = s.renderItem(s.current.items[1]);
  assert.match(html2, /due-tomorrow/, 'a dateless item gets the button too');
});

test('#99: no Tomorrow button on a checked item, one already due tomorrow, or a dated-off list', () => {
  const s = load([
    { id: 12, category_id: 1, checked: true, text: 'Ticked', due_date: '2026-10-17' },
    { id: 13, category_id: 1, checked: false, text: 'Already set', due_date: '2026-10-18' },
  ], { now: [2026, 9, 17] });
  assert.doesNotMatch(s.renderItem(s.current.items[0]), /due-tomorrow/, 'ticked row');
  assert.doesNotMatch(s.renderItem(s.current.items[1]), /due-tomorrow/, 'already due tomorrow');

  const s2 = load([{ id: 14, category_id: 1, checked: false, text: 'Milk' }], { dueDates: false });
  assert.doesNotMatch(s2.renderItem(s2.current.items[0]), /due-tomorrow/, 'due dates off');
});