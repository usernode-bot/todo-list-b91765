// When a shared-list item disappears, the activity line on Home must say who
// removed it — otherwise an item silently vanishing looks like a sync bug
// ("the shared list ate my task"). Removals are recorded at delete time and
// surface through the same activity union that already reports "added" and
// "checked".
//
// server.js opens a Postgres pool and listens on import, so it is asserted as
// source text — the same approach tests/invite-directory.test.js takes.
//
// Run with: node --test tests/item-removal-activity.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const SERVER = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');

// The body of DELETE /api/items/:id.
function itemDeleteBody() {
  const start = SERVER.indexOf("app.delete('/api/items/:id'");
  assert.notEqual(start, -1, 'DELETE /api/items/:id should exist');
  const end = SERVER.indexOf("app.get('/landing.html'", start);
  assert.notEqual(end, -1, 'the landing route should follow the item delete');
  return SERVER.slice(start, end);
}

// The body of DELETE /api/categories/:id.
function categoryDeleteBody() {
  const start = SERVER.indexOf("app.delete('/api/categories/:id'");
  assert.notEqual(start, -1, 'DELETE /api/categories/:id should exist');
  const end = SERVER.indexOf("app.post('/api/lists/:id/reorder-categories'", start);
  assert.notEqual(end, -1, 'the reorder route should follow the category delete');
  return SERVER.slice(start, end);
}

test('the schema creates an append-only item_events table', () => {
  assert.match(
    SERVER,
    /CREATE TABLE IF NOT EXISTS item_events \(\s*id SERIAL PRIMARY KEY,\s*list_id INTEGER NOT NULL REFERENCES lists\(id\) ON DELETE CASCADE,\s*actor VARCHAR\(255\) NOT NULL,\s*text TEXT NOT NULL,\s*removed_at TIMESTAMPTZ DEFAULT NOW\(\)\s*\);/,
    'item_events must be created with the lists cascade foreign key'
  );
  assert.match(
    SERVER,
    /COMMENT ON TABLE item_events IS 'staging:private';/,
    'item_events must be marked staging:private like the other tables'
  );
  assert.match(
    SERVER,
    /CREATE INDEX IF NOT EXISTS item_events_list_idx ON item_events \(list_id\);/,
    'the activity query needs an index on list_id'
  );
});

test('deleting an item records who removed it, atomically', () => {
  const body = itemDeleteBody();
  const insertAt = body.indexOf('INSERT INTO item_events');
  const deleteAt = body.indexOf('DELETE FROM items');
  assert.notEqual(insertAt, -1, 'the item delete must insert an item_events row');
  assert.notEqual(deleteAt, -1, 'the item delete must still delete the item');
  assert.ok(insertAt < deleteAt, 'the event must be recorded before the item row goes away');
  assert.match(body, /actor,\s*text/, 'the event needs the actor and the item text');
  assert.match(body, /req\.user\.username/, 'the actor is whoever deleted the item');
  assert.match(body, /BEGIN/, 'the insert and delete must share a transaction');
  assert.match(body, /COMMIT/, 'the transaction must be committed');
});

test('deleting a category records each of its items as removed', () => {
  const body = categoryDeleteBody();
  const selectAt = body.indexOf('SELECT text FROM items WHERE category_id');
  const insertAt = body.indexOf('INSERT INTO item_events');
  const deleteAt = body.indexOf('DELETE FROM categories');
  assert.notEqual(selectAt, -1, 'the category delete must read its item texts');
  assert.notEqual(insertAt, -1, 'the category delete must insert item_events rows');
  assert.notEqual(deleteAt, -1, 'the category delete must still delete the category');
  assert.ok(selectAt < insertAt && insertAt < deleteAt,
    'events must be recorded before the cascade removes the items');
  assert.match(body, /BEGIN/, 'the event inserts and the delete must share a transaction');
  assert.match(body, /COMMIT/, 'the transaction must be committed');
});

test('list deletion and import replace do not record removals', () => {
  const listDeleteStart = SERVER.indexOf("app.delete('/api/lists/:id'");
  const listDeleteEnd = SERVER.indexOf("app.post('/api/lists/import'", listDeleteStart);
  assert.doesNotMatch(SERVER.slice(listDeleteStart, listDeleteEnd), /item_events/,
    'deleting a whole list records nothing — the list and its activity line disappear together');

  const importStart = SERVER.indexOf("app.post('/api/lists/:id/import'");
  const importEnd = SERVER.indexOf('// The platform user directory', importStart);
  assert.doesNotMatch(SERVER.slice(importStart, importEnd), /item_events/,
    'bulk-import replace stays outside this change');
});

test('the home activity line includes removals from the last 7 days', () => {
  const activityStart = SERVER.indexOf("SELECT row_to_json(ev) FROM (");
  const activityEnd = SERVER.indexOf("FROM lists l", activityStart);
  const activity = SERVER.slice(activityStart, activityEnd);
  assert.match(
    activity,
    /UNION ALL\s*SELECT .* AS actor, 'removed' AS verb,/,
    'the activity union needs a removed branch'
  );
  assert.match(activity, /FROM item_events/, 'the removed branch reads from item_events');
  assert.match(activity, /LOWER\(e\.actor\) <> LOWER\(\$2\)/,
    'events by the viewer are filtered case-insensitively like the other branches');
  assert.match(activity, /removed_at > NOW\(\) - INTERVAL '7 days'/,
    'removals follow the existing 7-day activity window');
});

test('the renderer maps the removed verb to the word removed', () => {
  const fnStart = INDEX.indexOf('function activityLine');
  const fnEnd = INDEX.indexOf('function renderHome', fnStart);
  const fn = INDEX.slice(fnStart, fnEnd);
  assert.match(fn, /removed:\s*'removed'/, "the verb map must render 'removed' as removed");
  assert.match(fn, /added:\s*'added'/, "the verb map keeps 'added'");
  assert.match(fn, /\|\|\s*'checked'/, "'checked' stays the fallback");
  assert.match(fn, /44/, 'the existing 44-character truncation is kept');
});
