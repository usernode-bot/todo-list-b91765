// A brand-new account's first Home load seeds two example lists (issue #89),
// through the same API calls newList() and quick-add use, so the home screen
// is never empty on arrival. The seed is offered once per account on this
// device: the flag is written before the first POST, so a seed that dies
// halfway is never restarted (that would duplicate the first list).
//
// Like tests/checked-in-place.test.js, this lifts the function out of
// public/index.html by name and runs it in a vm with `api`, `rawGet`, `rawSet`,
// `NS` and `LOAD_TIMEOUT_MS` stubbed. It would catch the failure modes the
// request is about: a home that stays empty (no calls), lists created in the
// wrong order, items added in the wrong order, or a seed that retries and
// duplicates.
//
// Run with: node --test tests/example-lists.test.js

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
  if (INDEX.slice(start - 6, start) === 'async ') start -= 6;
  let i = INDEX.indexOf('{', INDEX.indexOf(')', start));
  let depth = 0;
  for (; i < INDEX.length; i++) {
    if (INDEX[i] === '{') depth++;
    else if (INDEX[i] === '}' && --depth === 0) return INDEX.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}()`);
}

function load(opts = {}) {
  const calls = []; // every API request, in order: [path, init]
  const log = [];   // API calls AND rawSet writes, in order
  let nextListId = 1, nextItemId = 1;
  const sandbox = {
    NS: 'todo:u42:',
    LOAD_TIMEOUT_MS: 12000,
    rawGet: () => (opts.seeded ? '1' : null),
    rawSet: (k, v) => log.push(['set', k]),
    api: async (path, init = {}) => {
      const out = await sandbox.respond(path, init);
      calls.push([path, init, out]);
      log.push(['api', path]);
      return out;
    },
    respond: async (path, init) => {
      const body = init.body ? JSON.parse(init.body) : {};
      if (path === '/api/lists') {
        if (init.method === 'POST') return { list: { id: nextListId++, name: body.name } };
        return { lists: [
          { id: 98, name: 'Groceries', open_count: 3, done_count: 1 },
          { id: 99, name: 'Weekend chores', open_count: 2, done_count: 1 },
        ] };
      }
      const add = path.match(/^\/api\/lists\/(\d+)\/items$/);
      if (add) return { item: { id: nextItemId++, list_id: +add[1], text: body.text, checked: false } };
      const patch = path.match(/^\/api\/items\/(\d+)$/);
      if (patch) return { item: { id: +patch[1], checked: true } };
      throw new Error('unexpected api call: ' + path);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(fnSource('seedExampleLists'), sandbox);
  return { s: sandbox, calls, log };
}

test('#89: a fresh home seeds the two example lists, in that order, and refetches', async () => {
  const { s, calls } = load();
  const out = await s.seedExampleLists([]);
  const posts = calls.filter(c => c[0] === '/api/lists' && c[1].method === 'POST');
  assert.deepEqual(posts.map(c => JSON.parse(c[1].body).name),
    ['Weekend chores', 'Groceries'],
    'both example lists created, chores first so groceries top the newest-first home');
  // The return is a refetch, not the empty array: Home paints real counts.
  assert.ok(out.length === 2 && out[0].open_count === 3, 'it returns the refetched lists');
  assert.ok(calls.some(c => c[0] === '/api/lists' && !c[1].method), 'a refetch actually happened');
});

test('#89: items are added in reverse so they read top-down, one pre-ticked per list', async () => {
  const { s, calls } = load();
  await s.seedExampleLists([]);
  // Quick-add inserts at the top, so the calls run bottom-up.
  const adds = calls.filter(c => /^\/api\/lists\/\d+\/items$/.test(c[0]));
  assert.deepEqual(adds.map(c => JSON.parse(c[1].body).text),
    ['Water plants', 'Laundry', 'Clean kitchen', 'Coffee', 'Bread', 'Eggs', 'Milk']);
  const patches = calls.filter(c => /^\/api\/items\/\d+$/.test(c[0]));
  assert.equal(patches.length, 2, 'exactly one item per list is pre-ticked');
  patches.forEach(c => assert.deepEqual(JSON.parse(c[1].body), { checked: true }));
  // "Water plants" (the 1st add) and "Bread" (the 5th add) are the ticked ones.
  const itemIdOf = add => add[2].item.id;
  assert.deepEqual(patches.map(c => +c[0].match(/\d+$/)[0]).sort((a, b) => a - b),
    [itemIdOf(adds[0]), itemIdOf(adds[4])].sort((a, b) => a - b));
});

test('#89: the once-only flag is written before the first POST, under this user', async () => {
  const { s, log } = load();
  await s.seedExampleLists([]);
  assert.equal(log[0][0], 'set', 'the flag is written first');
  assert.equal(log[0][1], 'todo:u42:example-lists-seeded');
  assert.equal(log[1][0], 'api', 'and the first API call comes after it');
  assert.ok(/^\/api\/lists$/.test(log[1][1]));
});

test('#89: no-ops when the home is not empty or the seed already ran', async () => {
  const a = load();
  await a.s.seedExampleLists([{ id: 1, name: 'Mine' }]);
  assert.equal(a.calls.length, 0, 'an existing list means no seed');

  const b = load({ seeded: true });
  await b.s.seedExampleLists([]);
  assert.equal(b.calls.length, 0, 'the flag means no seed — deleted examples stay deleted');
});

test('#89: a mid-seed failure returns the lists untouched, without a retry', async () => {
  const { s } = load();
  let posts = 0;
  s.api = async (path, init = {}) => {
    if (path === '/api/lists' && init.method === 'POST') posts++;
    if (path === '/api/lists/1/items' && init.method === 'POST') {
      const e = new Error('boom');
      e.network = true;
      throw e;
    }
    if (path === '/api/lists') {
      if (init.method === 'POST') return { list: { id: 1, name: JSON.parse(init.body).name } };
      return { lists: [] };
    }
    throw new Error('unexpected api call: ' + path);
  };
  const out = await s.seedExampleLists([]);
  assert.deepEqual(out, [], 'the empty list comes back so Home shows "No lists yet."');
  assert.equal(posts, 1, 'the second list is never started — no duplicated seed on the next load');
});
