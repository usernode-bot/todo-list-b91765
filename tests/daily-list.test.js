// Daily lists (issue #109): any list can be turned into a daily list. Each new
// local day, unfinished tasks dated before today move to today; tasks ticked
// stay with the day they were ticked, in a folded section below.
//
// Like tests/due-tomorrow.test.js, this lifts the pure functions out of
// public/index.html by name and runs them in a vm, and asserts server.js as
// source text (the repo has no Postgres-backed test harness).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const INDEX = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

// The source of `function name(...) { ... }`, found by brace matching.
function fnSource(src, name) {
  let start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `should define ${name}()`);
  if (src.slice(start - 6, start) === 'async ') start -= 6;
  let i = src.indexOf('{', src.indexOf(')', start));
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

const LIFTED = ['parseISODate', 'todayISO', 'fmtDueTime', 'dayLabel', 'dueLabel', 'dayOfTick', 'rolloverLocal'];

// A Date whose no-argument constructor reads as a fixed wall-clock moment
// (noon local, away from any DST edge); constructed with args it behaves
// normally, so new Date(i.completed_at) still parses ISO strings.
function fakeDateAt(y, m, d) {
  return class extends Date {
    constructor(...args) { super(...(args.length ? args : [y, m, d, 12])); }
  };
}

function load(items, opts = {}) {
  const sandbox = {
    LOCALE: undefined,
    Date: fakeDateAt(...(opts.now || [2026, 9, 21])),
  };
  vm.createContext(sandbox);
  vm.runInContext(LIFTED.map(n => fnSource(INDEX, n)).join('\n'), sandbox);
  return sandbox;
}

const plain = o => ({ ...o });

test('#109: rolloverLocal moves only unfinished, non-repeating, past-dated tasks', () => {
  const s = load([], { now: [2026, 9, 21] }); // 21 Oct 2026
  const d = {
    list: { id: 7, daily_enabled: true, last_rollover_date: null },
    items: [
      { id: 1, checked: false, due_date: '2026-10-20', repeat_rule: null }, // yesterday, open → moves
      { id: 2, checked: false, due_date: '2026-10-19', repeat_rule: null }, // older, open → moves
      { id: 3, checked: true,  due_date: '2026-10-20', repeat_rule: null }, // ticked → stays
      { id: 4, checked: false, due_date: '2026-10-19', repeat_rule: 'weekly' }, // repeating → stays
      { id: 5, checked: false, due_date: null,        repeat_rule: null }, // undated → stays
      { id: 6, checked: false, due_date: '2026-10-25', repeat_rule: null }, // later → stays
    ],
  };
  s.rolloverLocal(d, '2026-10-21');
  assert.deepEqual(d.items.map(i => i.due_date),
    ['2026-10-21', '2026-10-21', '2026-10-20', '2026-10-19', null, '2026-10-25']);
  assert.equal(d.list.last_rollover_date, '2026-10-21');
});

test('#109: running the rollover again changes nothing more', () => {
  const s = load([]);
  const d = {
    list: { id: 7, daily_enabled: true, last_rollover_date: null },
    items: [{ id: 1, checked: false, due_date: '2026-10-20' }],
  };
  s.rolloverLocal(d, '2026-10-21');
  const once = JSON.stringify(d);
  s.rolloverLocal(d, '2026-10-21');
  assert.equal(JSON.stringify(d), once);
});

test('#109: dayLabel names nearby days and dates older ones', () => {
  const s = load([], { now: [2026, 9, 21] });
  assert.equal(s.dayLabel('2026-10-21'), 'Today');
  assert.equal(s.dayLabel('2026-10-20'), 'Yesterday');
  assert.equal(s.dayLabel('2026-10-19'), new Date(2026, 9, 19).toLocaleDateString(undefined, { weekday: 'short' }));
  assert.equal(s.dayLabel('2026-10-01'), new Date(2026, 9, 1).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
  assert.equal(s.dayLabel('2025-12-01'), new Date(2025, 11, 1).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }));
});

test('#109: dueLabel still reads exactly as before', () => {
  const s = load([], { now: [2026, 9, 21] });
  assert.equal(s.dueLabel({ due_date: '2026-10-21' }), 'Today');
  assert.equal(s.dueLabel({ due_date: '2026-10-22' }), 'Tomorrow');
  assert.equal(s.dueLabel({ due_date: '2026-10-20' }), 'Yesterday');
  assert.equal(s.dueLabel({ due_date: '2026-10-23' }), new Date(2026, 9, 23).toLocaleDateString(undefined, { weekday: 'short' }));
  assert.equal(s.dueLabel({ due_date: '2026-11-15' }), new Date(2026, 10, 15).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
  assert.equal(s.dueLabel({ due_date: '2026-10-21', due_time: '09:30' }),
    'Today · ' + new Date(2000, 0, 1, 9, 30).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
  assert.equal(s.dueLabel({}), '');
});

test('#109: dayOfTick reads the phone-local date of completed_at', () => {
  const s = load([], { now: [2026, 9, 21] });
  const iso = new Date(2026, 9, 19, 15, 30).toISOString();
  assert.equal(s.dayOfTick({ checked: true, completed_at: iso }), '2026-10-19');
  assert.equal(s.dayOfTick({ checked: true, completed_at: null }), '2026-10-21',
    'rows from before completed_at count as today');
});

test('#109: both daily columns are append-only and nullable', () => {
  assert.match(SERVER, /ALTER TABLE lists ADD COLUMN IF NOT EXISTS daily_enabled BOOLEAN;/);
  assert.match(SERVER, /ALTER TABLE lists ADD COLUMN IF NOT EXISTS last_rollover_date DATE;/);
  // No default and no backfill: an ordinary list is untouched by this change.
  assert.doesNotMatch(SERVER, /daily_enabled BOOLEAN (NOT NULL )?DEFAULT/);
});

test('#109: a queued rollover is actually sent, not silently dropped', async () => {
  const calls = [];
  let queue = [{ type: 'rollover', method: 'POST', path: '/api/lists/7/rollover', body: { today: '2026-10-23' } }];
  const sandbox = {
    MUTATION_TIMEOUT_MS: 1000,
    isTempId: id => id < 0,
    loadQueue: () => queue,
    saveQueue: q => { queue = q; return true; },
    api: async (path, opts) => { calls.push({ path, opts }); return {}; },
    adoptServerItem() {},
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource(INDEX, 'runOp'), sandbox);
  await sandbox.runOp(queue[0]);
  assert.equal(calls.length, 1, 'one request');
  assert.equal(calls[0].path, '/api/lists/7/rollover');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(JSON.parse(calls[0].opts.body).today, '2026-10-23');
  assert.equal(queue.length, 0, 'the op leaves the queue once sent');
});

test('#109: the rollover endpoint is idempotent and forward-only', () => {
  const start = SERVER.indexOf("app.post('/api/lists/:id/rollover'");
  assert.notEqual(start, -1, 'POST /api/lists/:id/rollover should exist');
  const body = SERVER.slice(start, SERVER.indexOf("app.delete('/api/lists/:id'", start));
  // Only the first open of a new day moves anything.
  assert.match(body, /daily_enabled IS TRUE/);
  assert.match(body, /last_rollover_date IS NULL OR last_rollover_date < \$2/);
  // Only unfinished, non-repeating, dated tasks move.
  assert.match(body, /NOT i\.checked/);
  assert.match(body, /i\.repeat_rule IS NULL/);
  assert.match(body, /i\.due_date IS NOT NULL/);
  assert.match(body, /i\.due_date < \$2/);
  // Any member may open the list; a stranger gets a 404.
  assert.match(body, /if \(!list \|\| !role\) return res\.status\(404\)/);
});

test('#109: the daily switch is owner-only, next to due dates', () => {
  const start = SERVER.indexOf("app.patch('/api/lists/:id'");
  const body = SERVER.slice(start, SERVER.indexOf("app.post('/api/lists/:id/rollover'", start));
  assert.match(body, /if \(role !== 'owner'\) return res\.status\(403\)/);
  assert.match(body, /typeof req\.body\.daily_enabled === 'boolean'/);
  const drawer = INDEX.slice(INDEX.indexOf('function drawerItemsHtml('),
    INDEX.indexOf('function renderList('));
  assert.match(drawer, /<span>Daily list<\/span>/);
  assert.match(drawer, /class="un-switch daily-switch"/);
  // The daily label follows the due-dates one, both inside the owner block.
  assert.ok(drawer.indexOf('Include due dates') < drawer.indexOf('Daily list'),
    'the daily switch sits under Include due dates');
});

test('#109: the daily view replaces a category\'s done section with today\'s ticks', () => {
  assert.match(INDEX, /if \(dailyOn\(\) && !searching\) checked = checked\.filter\(i => dayOfTick\(i\) === todayISO\(\)\)/);
  assert.match(INDEX, /<h2 class="un-group-header flex-1 truncate text-left">Today<\/h2>/);
  // Earlier days are grouped by dayOfTick and rendered behind a folded toggle.
  assert.match(INDEX, /function renderDays\(\)/);
  assert.match(INDEX, /class="day-toggle[^"]*"[\s\S]*?aria-expanded="\$\{open \? 'true' : 'false'\}"/);
});
