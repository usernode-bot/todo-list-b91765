// Repeating tasks (issue #102): a task can repeat daily, weekly or monthly,
// chosen in the due-date editor. Ticking it leaves it ticked in Completed and
// a fresh copy appears in the open tasks with the next due date, so a weekly
// grocery run only has to be typed once. The copy is made on the client, in
// the same tap, through the ordinary add-then-due op pair — the server never
// spawns copies, so the tick works offline and can't double-insert.
//
// Like tests/due-tomorrow.test.js, this lifts the functions out of
// public/index.html by name and runs them in a vm against a fake list with
// the DOM-facing helpers stubbed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

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
  'dayLabel', 'dueLabel', 'isOverdue', 'nextDue', 'applyDue', 'toggleItem', 'spawnRepeat',
  'localNewItem', 'deleteItem', 'runHistory', 'remapHistoryId',
  'isCatFullyDone', 'renderItem', 'saveDue', 'clearDue',
];

// A Date whose no-argument constructor reads as a fixed wall-clock moment
// (noon local, away from any DST edge); constructed with args it behaves
// normally, so parseISODate still works.
function fakeDateAt(y, m, d) {
  return class extends Date {
    constructor(...args) { if (args.length) super(...args); else super(y, m, d, 12); }
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
    REPEAT_TEXT: { daily: 'Daily', weekly: 'Weekly', monthly: 'Monthly' },
    me: 'evan',
    tempSeq: -1,
    historyBusy: false,
    undoStack: [],
    redoStack: [],
    commits,
    records,
    commit: op => { commits.push(op); return true; },
    // Mirrors the real record()'s guard: a step run inside another action's
    // undo entry (the spawned copy's due op) records nothing.
    record: entry => { if (!sandbox.historyBusy) records.push(entry); },
    cacheList() {},
    repaintCategory() {},
    setCatCollapsed() {},
    clearKeepOpen() {},
    catShowDone: () => true,
    closeDueEditor() {},
    toast() {},
    document: { getElementById: id => ({ value: (opts.fields && opts.fields[id]) || '' }) },
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

test('#102: nextDue steps daily and weekly, counted on from the task due date', () => {
  const s = load([], { now: [2026, 9, 19] });
  assert.equal(s.nextDue('2026-10-19', 'daily'), '2026-10-20');
  assert.equal(s.nextDue('2026-10-24', 'weekly'), '2026-10-31', 'same weekday a week later');
  assert.equal(s.nextDue('2026-10-24', 'daily'), '2026-10-25', 'daily ignores the weekday');
});

test('#102: nextDue rolls monthly over month ends, short months and the year', () => {
  const s = load([], { now: [2026, 9, 19] });
  assert.equal(s.nextDue('2026-12-15', 'monthly'), '2027-01-15', 'December rolls to January');
  assert.equal(s.nextDue('2027-01-31', 'monthly'), '2027-02-28', 'clamped to the month end');
  assert.equal(s.nextDue('2028-01-31', 'monthly'), '2028-02-29', 'leap year keeps the 29th');
  // The clamp is not sticky: counting on from the clamped 28th keeps the 28th.
  assert.equal(s.nextDue('2027-02-28', 'monthly'), '2027-03-28');
});

test('#102: nextDue returns null for a null date or an unknown rule', () => {
  const s = load([], { now: [2026, 9, 19] });
  assert.equal(s.nextDue(null, 'weekly'), null);
  assert.equal(s.nextDue('2026-10-24', null), null);
  assert.equal(s.nextDue('2026-10-24', 'hourly'), null);
});

test('#102: ticking a weekly item queues a toggle, an add and a due op, and spawns an open copy', () => {
  const s = load([{ id: 10, category_id: 1, text: 'Grocery run', checked: false,
                    due_date: '2026-10-24', due_time: '09:30', repeat_rule: 'weekly' }],
                 { now: [2026, 9, 19] });
  s.toggleItem(10, true);
  assert.equal(s.commits.length, 3, 'toggle, add and due ops queued');
  assert.equal(s.commits[0].type, 'toggle');
  assert.deepEqual(plain(s.commits[0].body), { checked: true, repeat_rule: null },
    'the ticked original hands its rule over');
  assert.equal(s.commits[1].type, 'add');
  assert.equal(s.commits[1].path, '/api/categories/1/items', 'the copy lands in the same category');
  assert.deepEqual(plain(s.commits[1].body), { text: 'Grocery run', repeat_rule: 'weekly' });
  assert.equal(s.commits[2].type, 'due');
  assert.deepEqual(plain(s.commits[2].body),
    { due_date: '2026-10-31', due_time: '09:30', repeat_rule: 'weekly' },
    'the copy is due a week later and keeps the time');
  const item = s.current.items.find(i => i.id === 10);
  assert.equal(item.checked, true);
  assert.equal(item.repeat_rule, null, 'the original no longer repeats');
  const copy = s.current.items.find(i => i.id < 0);
  assert.ok(copy, 'an open copy exists');
  assert.equal(copy.checked, false);
  assert.equal(copy.repeat_rule, 'weekly');
  assert.equal(copy.due_date, '2026-10-31');
  assert.equal(s.records.length, 1, 'one history entry for the whole tap');
  assert.equal(s.records[0].spawnId, copy.id, 'the entry follows the copy');
  assert.deepEqual(plain(s.records[0].after), { checked: true, repeat_rule: null });
  assert.deepEqual(plain(s.records[0].before), { checked: false, repeat_rule: 'weekly' });
});

test('#102: ticking an undated daily item spawns an undated copy, with no due op', () => {
  const s = load([{ id: 11, category_id: 1, text: 'Stretch', checked: false,
                    repeat_rule: 'daily' }], { now: [2026, 9, 19] });
  s.toggleItem(11, true);
  assert.equal(s.commits.length, 2, 'toggle and add only — no due op');
  assert.equal(s.commits[1].type, 'add');
  const copy = s.current.items.find(i => i.id < 0);
  assert.equal(copy.due_date, null, 'the copy has no date either');
});

test('#102: ticking a non-repeating item is a plain tick, as before', () => {
  const s = load([{ id: 12, category_id: 1, text: 'Milk', checked: false }],
                 { now: [2026, 9, 19] });
  const spawned = s.toggleItem(12, true);
  assert.equal(s.commits.length, 1, 'toggle op only');
  assert.equal(spawned, null, 'nothing spawned');
  assert.deepEqual(s.current.items.map(i => i.id), [12], 'no copy');
});

test('#102: undoing a repeating tick removes the copy and restores the rule', () => {
  const s = load([{ id: 10, category_id: 1, text: 'Grocery run', checked: false,
                    due_date: '2026-10-24', due_time: '09:30', repeat_rule: 'weekly' }],
                 { now: [2026, 9, 19] });
  s.toggleItem(10, true);
  const copyId = s.records[0].spawnId;
  assert.ok(s.runHistory(s.records[0], 'undo'));
  assert.ok(!s.current.items.some(i => i.id === copyId), 'the copy is gone');
  const item = s.current.items.find(i => i.id === 10);
  assert.equal(item.checked, false, 'the original is unticked');
  assert.equal(item.repeat_rule, 'weekly', 'its rule is back');
});

test('#102: the editor Save sends the chosen repeat; Clear sends all three as null', () => {
  const s = load([{ id: 10, category_id: 1, text: 'Bin day', checked: false }],
                 { now: [2026, 9, 19],
                   fields: { 'due-date-input': '2026-11-01', 'due-time-input': '',
                             'due-repeat-input': 'monthly' } });
  s.saveDue(10);
  assert.deepEqual(plain(s.commits[0].body),
    { due_date: '2026-11-01', due_time: null, repeat_rule: 'monthly' });
  // Clear empties date, time and repeat together.
  s.clearDue(10);
  assert.deepEqual(plain(s.commits[1].body),
    { due_date: null, due_time: null, repeat_rule: null });
});

test('#102: a due change without a repeat argument keeps the rule the item has', () => {
  const s = load([{ id: 10, category_id: 1, text: 'Bin day', checked: false,
                    repeat_rule: 'monthly' }], { now: [2026, 9, 19] });
  s.applyDue(10, '2026-11-02', null);
  assert.equal(s.current.items[0].repeat_rule, 'monthly',
    'dueTomorrow and the existing callers never clear a repeat');
  assert.equal(s.current.items[0].due_date, '2026-11-02');
});

test('#102: a dated repeating row shows the repeat mark on its chip', () => {
  const s = load([{ id: 10, category_id: 1, text: 'Grocery run', checked: false,
                    due_date: '2026-10-24', repeat_rule: 'weekly' }],
                 { now: [2026, 9, 19] });
  const html = s.renderItem(s.current.items[0]);
  assert.match(html, /data-repeat="weekly"/);
  assert.match(html, /↻ Sat/, 'the mark leads the date label');
  assert.match(html, /Repeats weekly/, 'the hover text says the cadence');
});

test('#102: an undated repeating row shows a repeat pill, not "+ date"', () => {
  const s = load([{ id: 11, category_id: 1, text: 'Stretch', checked: false,
                    repeat_rule: 'weekly' }], { now: [2026, 9, 19] });
  const html = s.renderItem(s.current.items[0]);
  assert.match(html, /data-repeat="weekly"/);
  assert.match(html, /↻ Weekly/);
  assert.doesNotMatch(html, /\+ date/, 'the dashed add-date pill is replaced');
  const plain2 = load([{ id: 12, category_id: 1, text: 'Milk', checked: false }],
                      { now: [2026, 9, 19] });
  assert.match(plain2.renderItem(plain2.current.items[0]), /\+ date/, 'undated rows without a rule are unchanged');
});

test('#102: the server stores the repeat rule and reads it back', () => {
  assert.match(SERVER, /ADD COLUMN IF NOT EXISTS repeat_rule TEXT/,
    'the items table carries a nullable repeat_rule');
  assert.match(SERVER, /i\.repeat_rule/,
    'the list detail SELECT reads it');
  assert.match(SERVER, /repeat_rule\s*\n\s*FROM items WHERE id = \$1/,
    'the item PATCH SELECT reads it back');
  assert.match(SERVER, /repeat_rule must be daily, weekly, monthly or null/,
    'a bad value is rejected');
  assert.match(SERVER, /'Grocery run'/, 'the staging demo list seeds one weekly example');
});