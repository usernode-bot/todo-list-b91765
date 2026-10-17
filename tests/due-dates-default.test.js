// Due dates are on by default for every list (issue #97): new lists get a TRUE
// column default, and existing lists were switched on exactly once by a
// marker-gated backfill that leaves lists whose owner had turned dates off
// (a list still holding dated items) alone. The "Include due dates" switch
// keeps working, so an owner's later off sticks across reboots.
//
// server.js opens a Postgres pool and listens on import, so it is asserted as
// source text — the same approach tests/seed-example-lists.test.js takes.
//
// Run with: node --test tests/due-dates-default.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

function schemaBody() {
  const start = SERVER.indexOf('async function start()');
  assert.notEqual(start, -1, 'start() should exist');
  const end = SERVER.indexOf('server = app.listen', start);
  assert.notEqual(end, -1, 'the schema block should end at the listen call');
  return SERVER.slice(start, end);
}

test('the column default is on for new lists', () => {
  const schema = schemaBody();
  // The original ADD COLUMN stays (a fresh database still creates the
  // column), and the default is flipped to TRUE right after it.
  assert.match(schema, /ADD COLUMN IF NOT EXISTS due_dates_enabled BOOLEAN NOT NULL DEFAULT FALSE/);
  assert.match(schema, /ALTER TABLE lists ALTER COLUMN due_dates_enabled SET DEFAULT TRUE/);
});

test('the backfill is one-time, gated on a migration marker', () => {
  const schema = schemaBody();
  assert.match(schema, /CREATE TABLE IF NOT EXISTS app_migrations/);
  // The UPDATE only runs on the boot that first inserts the marker row: it
  // appears inside a WITH ... RETURNING whose name the UPDATE checks with
  // EXISTS, so a restart that finds the row on conflict skips the UPDATE.
  const cte = /WITH\s+(\w+)\s+AS\s*\(\s*INSERT INTO app_migrations\s+\(name\)\s+VALUES \('due_dates_default_on'\)\s+ON CONFLICT \(name\) DO NOTHING\s+RETURNING name\s*\)\s*UPDATE lists l SET due_dates_enabled = TRUE[\s\S]*?EXISTS \(SELECT 1 FROM \1\)/;
  assert.match(schema, cte, 'the UPDATE is gated on the marker insert');
});

test('the backfill keeps lists whose owner turned dates off', () => {
  const schema = schemaBody();
  // A list that still holds dated items but has dates off was switched off
  // on purpose, so the backfill leaves it alone.
  assert.match(schema, /UPDATE lists l SET due_dates_enabled = TRUE[\s\S]*?NOT EXISTS \(\s*SELECT 1 FROM items i JOIN categories c ON i\.category_id = c\.id\s*WHERE c\.list_id = l\.id AND i\.due_date IS NOT NULL\)/);
});

test('the backfill runs after the items and categories tables exist', () => {
  const schema = schemaBody();
  // The guard's subquery reads items.due_date, so the marker CTE and the
  // UPDATE must come after both tables and their due_date column.
  const addItems = schema.indexOf('ADD COLUMN IF NOT EXISTS due_date DATE');
  const backfill = schema.indexOf("VALUES ('due_dates_default_on')");
  assert.ok(addItems !== -1 && backfill !== -1 && backfill > addItems,
    'the backfill comes after the due_date column is added');
});

test('the side-menu switch still writes the per-list setting', () => {
  // The PATCH route keeps setting the column directly, so an owner can still
  // turn dates off for one list — and that off persists.
  const patchAt = SERVER.indexOf("app.patch('/api/lists/:id'");
  assert.notEqual(patchAt, -1, 'PATCH /api/lists/:id should exist');
  const body = SERVER.slice(patchAt, patchAt + 2000);
  assert.match(body, /UPDATE lists SET due_dates_enabled = \$1/,
    'the switch still writes due_dates_enabled');
});