// A brand-new user's first Home load should not greet them with an empty
// screen: two example lists (with a few items, one already ticked) are seeded
// the first time they load Home owning or belonging to no list at all. They
// are ordinary lists — the no-lists guard means deleting them is permanent.
//
// server.js opens a Postgres pool and listens on import, so it is asserted as
// source text — the same approach tests/item-removal-activity.test.js takes.
//
// Run with: node --test tests/seed-example-lists.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

function seedDemoBody() {
  const start = SERVER.indexOf('async function seedDemoListFor(');
  assert.notEqual(start, -1, 'seedDemoListFor should exist');
  const end = SERVER.indexOf('async function seedExampleListsFor(', start);
  assert.notEqual(end, -1, 'seedExampleListsFor should follow seedDemoListFor');
  return SERVER.slice(start, end);
}

function seedExampleBody() {
  const start = SERVER.indexOf('async function seedExampleListsFor(');
  assert.notEqual(start, -1, 'seedExampleListsFor should exist');
  const end = SERVER.indexOf('// ---------------------------------------------------------------------------', start);
  assert.notEqual(end, -1, 'the schema section should follow the example seed');
  return SERVER.slice(start, end);
}

function listsRouteBody() {
  const start = SERVER.indexOf("app.get('/api/lists'");
  assert.notEqual(start, -1, "GET /api/lists should exist");
  const end = SERVER.indexOf("app.post('/api/lists'", start);
  assert.notEqual(end, -1, 'the create route should follow the list route');
  return SERVER.slice(start, end);
}

test('a no-lists user is detected the same way the staging seed detects one', () => {
  const example = seedExampleBody();
  const demo = seedDemoBody();
  // The same owner-or-member existence query, returning early when any list
  // is found — so users who already have anything never see the examples,
  // and a user who deletes them never gets them back.
  const guard = /SELECT 1 FROM lists\s+WHERE owner_id = \$1\s+OR EXISTS \(SELECT 1 FROM list_members m WHERE m\.list_id = lists\.id\s+AND \(m\.user_id = \$1 OR LOWER\(m\.username\) = LOWER\(\$2\)\)\)\s+LIMIT 1/;
  assert.match(demo, guard, 'the staging seed keeps its existing guard');
  assert.match(example, guard, 'the example seed reuses the identical guard');
  const guardAt = example.search(guard);
  const earlyReturn = example.indexOf('if (rows.length) return;', guardAt);
  assert.notEqual(earlyReturn, -1, 'the guard must return before any insert');
});

test('the example seed runs in one transaction and rolls back on failure', () => {
  const body = seedExampleBody();
  const beginAt = body.indexOf('BEGIN');
  const commitAt = body.indexOf('COMMIT');
  const rollbackAt = body.indexOf('ROLLBACK');
  assert.ok(beginAt !== -1 && beginAt < commitAt, 'the inserts must share a transaction');
  assert.notEqual(rollbackAt, -1, 'a failure must roll the seed back fully');
  assert.match(body, /finally\s*\{\s*client\.release\(\)/, 'the client is always released');
});

test('both example lists are created with a default General category and their items', () => {
  const body = seedExampleBody();
  assert.match(body, /'Groceries'/, 'the first example list is Groceries');
  assert.match(body, /'Weekend chores'/, 'the second example list is Weekend chores');
  for (const item of ['Milk', 'Eggs', 'Bread', 'Coffee', 'Clean kitchen', 'Laundry', 'Water plants']) {
    assert.match(body, new RegExp(`'${item}'`), `the seed includes the item "${item}"`);
  }
  // Each list gets the same default category a hand-created list gets.
  const generalCount = (body.match(/'General', TRUE, 0/g) || []).length;
  assert.equal(generalCount, 2, 'each example list has its own default General category');
});

test('the pre-ticked items look like the user ticked them themself', () => {
  const body = seedExampleBody();
  // Exactly two rows are seeded checked, each with completed_at and
  // last_checked_by attributed to the user — so no "@someone checked …"
  // activity line appears on Home for the examples.
  assert.match(body, /'Bread', TRUE, 3, NOW\(\), \$\d+, \$\d+/,
    'Bread is seeded checked, keeping its inserted sort_order');
  assert.match(body, /'Water plants', TRUE, 3, NOW\(\), \$\d+, \$\d+/,
    'Water plants is seeded checked, keeping its inserted sort_order');
  assert.match(body, /INSERT INTO items \(category_id, text, checked, sort_order, completed_at, created_by, last_checked_by\)/,
    'checked rows carry completed_at and last_checked_by like a real check');
});

test('GET /api/lists seeds the examples outside any staging gate', () => {
  const body = listsRouteBody();
  const stagingAt = body.indexOf('if (IS_STAGING) await seedDemoListFor(req.user);');
  assert.notEqual(stagingAt, -1, 'the staging demo seed keeps its staging gate');
  const exampleAt = body.indexOf('await seedExampleListsFor(req.user);');
  assert.notEqual(exampleAt, -1, 'GET /api/lists must call the example seed');
  assert.ok(exampleAt > stagingAt, 'the example seed runs after the staging seed');
  const lineStart = body.lastIndexOf('\n', exampleAt) + 1;
  const line = body.slice(lineStart, exampleAt + 'await seedExampleListsFor(req.user);'.length);
  assert.doesNotMatch(line, /IS_STAGING/,
    'the examples are a production feature, not gated on staging');
});

test('the seed introduces no new tables or columns', () => {
  const body = seedExampleBody();
  assert.doesNotMatch(body, /CREATE TABLE|ALTER TABLE|ADD COLUMN/,
    'the seed uses the existing schema only');
});
