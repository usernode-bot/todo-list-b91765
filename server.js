const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET;
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_SECRET) {
    try { req.user = jwt.verify(token, JWT_SECRET); } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ---------------------------------------------------------------------------
// Access control
//
// A list is visible to its owner and to invited members. Invites are by
// username (no accept step), so a member row may predate the invitee ever
// opening the app — membership matches on user_id OR username
// (case-insensitive). When a username-only member shows up we backfill
// their user_id so future checks are exact.
// ---------------------------------------------------------------------------

async function getListRole(listId, user) {
  const { rows } = await pool.query(
    `SELECT l.*,
            (l.owner_id = $2) AS is_owner,
            (SELECT m.id FROM list_members m
              WHERE m.list_id = l.id
                AND (m.user_id = $2 OR LOWER(m.username) = LOWER($3))
              LIMIT 1) AS member_row_id
       FROM lists l WHERE l.id = $1`,
    [listId, user.id, user.username]
  );
  if (!rows.length) return { list: null, role: null };
  const list = rows[0];
  if (list.is_owner) return { list, role: 'owner' };
  if (list.member_row_id) {
    // Backfill user_id on username-only invites.
    await pool.query(
      `UPDATE list_members SET user_id = $1 WHERE id = $2 AND user_id IS NULL`,
      [user.id, list.member_row_id]
    );
    return { list, role: 'member' };
  }
  return { list, role: null };
}

// Resolves a category id to its list and checks the requester has access.
async function getCategoryAccess(categoryId, user) {
  const { rows } = await pool.query(`SELECT * FROM categories WHERE id = $1`, [categoryId]);
  if (!rows.length) return { category: null, list: null, role: null };
  const category = rows[0];
  const { list, role } = await getListRole(category.list_id, user);
  return { category, list, role };
}

// Resolves an item id to its category/list and checks access.
async function getItemAccess(itemId, user) {
  const { rows } = await pool.query(`SELECT * FROM items WHERE id = $1`, [itemId]);
  if (!rows.length) return { item: null, category: null, list: null, role: null };
  const item = rows[0];
  const { category, list, role } = await getCategoryAccess(item.category_id, user);
  return { item, category, list, role };
}

// ---------------------------------------------------------------------------
// SSE live updates
//
// Clients viewing a list subscribe to /api/lists/:id/events. Every mutation
// broadcasts a small "something changed" event to that list's subscribers,
// who refetch. Events carry the mutating client's id (x-client-id header)
// so the originating tab can ignore its own echo.
// ---------------------------------------------------------------------------

const listStreams = new Map(); // listId -> Set<res>

function broadcast(listId, event) {
  const subs = listStreams.get(Number(listId));
  if (!subs) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of subs) {
    try { res.write(payload); } catch (_) { /* dropped connection; close cleans up */ }
  }
}

function notify(listId, req, type = 'changed') {
  broadcast(listId, { type, sourceClient: req.headers['x-client-id'] || null });
}

function closeListStreams(listId) {
  const subs = listStreams.get(Number(listId));
  if (!subs) return;
  for (const res of subs) { try { res.end(); } catch (_) {} }
  listStreams.delete(Number(listId));
}

// Keep connections alive through proxies that time out idle streams.
setInterval(() => {
  for (const subs of listStreams.values()) {
    for (const res of subs) { try { res.write(': ping\n\n'); } catch (_) {} }
  }
}, 25000).unref();

// EventSource can't set headers, so auth rides the ?token= query param,
// which the auth middleware already accepts.
app.get('/api/lists/:id/events', async (req, res) => {
  try {
    const { list, role } = await getListRole(req.params.id, req.user);
    if (!list || !role) return res.status(404).json({ error: 'List not found' });
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const key = Number(list.id);
    let subs = listStreams.get(key);
    if (!subs) listStreams.set(key, (subs = new Set()));
    subs.add(res);
    req.on('close', () => {
      subs.delete(res);
      if (!subs.size) listStreams.delete(key);
    });
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------

// Home: lists the user owns or is a member of. `activity` is the most
// recent item event by someone OTHER than the requester in the last week —
// the passive shared-list re-engagement hint rendered on the Home row.
app.get('/api/lists', async (req, res) => {
  try {
    if (IS_STAGING) await seedDemoListFor(req.user);
    const { rows } = await pool.query(
      `SELECT l.id, l.name, l.owner_id, l.owner_username, l.created_at,
              (l.owner_id = $1) AS is_owner,
              (SELECT COUNT(*) FROM list_members m WHERE m.list_id = l.id) AS member_count,
              (SELECT COUNT(*) FROM items i JOIN categories c ON i.category_id = c.id
                WHERE c.list_id = l.id AND NOT i.checked) AS open_count,
              (SELECT COUNT(*) FROM items i JOIN categories c ON i.category_id = c.id
                WHERE c.list_id = l.id AND i.checked) AS done_count,
              (SELECT row_to_json(ev) FROM (
                 SELECT x.actor, x.verb, x.text FROM (
                   SELECT i.last_checked_by AS actor, 'checked' AS verb, i.text, i.completed_at AS at
                     FROM items i JOIN categories c ON i.category_id = c.id
                    WHERE c.list_id = l.id AND i.checked AND i.last_checked_by IS NOT NULL
                      AND LOWER(i.last_checked_by) <> LOWER($2)
                      AND i.completed_at > NOW() - INTERVAL '7 days'
                   UNION ALL
                   SELECT i.created_by AS actor, 'added' AS verb, i.text, i.created_at AS at
                     FROM items i JOIN categories c ON i.category_id = c.id
                    WHERE c.list_id = l.id AND i.created_by IS NOT NULL
                      AND LOWER(i.created_by) <> LOWER($2)
                      AND i.created_at > NOW() - INTERVAL '7 days'
                 ) x ORDER BY x.at DESC LIMIT 1
               ) ev) AS activity
         FROM lists l
        WHERE l.owner_id = $1
           OR EXISTS (SELECT 1 FROM list_members m WHERE m.list_id = l.id
                        AND (m.user_id = $1 OR LOWER(m.username) = LOWER($2)))
        ORDER BY l.created_at DESC`,
      [req.user.id, req.user.username]
    );
    res.json({ lists: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create a list (+ its default "General" category).
app.post('/api/lists', async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'List name is required' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO lists (name, owner_id, owner_username) VALUES ($1, $2, $3) RETURNING *`,
      [name, req.user.id, req.user.username]
    );
    await client.query(
      `INSERT INTO categories (list_id, name, is_default, sort_order) VALUES ($1, 'General', TRUE, 0)`,
      [rows[0].id]
    );
    await client.query('COMMIT');
    res.json({ list: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Full list detail: categories, items (unchecked first, then checked), members.
app.get('/api/lists/:id', async (req, res) => {
  try {
    const { list, role } = await getListRole(req.params.id, req.user);
    if (!list || !role) return res.status(404).json({ error: 'List not found' });

    const [cats, items, members] = await Promise.all([
      pool.query(`SELECT id, name, is_default, sort_order FROM categories
                   WHERE list_id = $1 ORDER BY sort_order, id`, [list.id]),
      pool.query(`SELECT i.id, i.category_id, i.text, i.checked, i.sort_order, i.completed_at, i.created_by, i.last_checked_by
                    FROM items i JOIN categories c ON i.category_id = c.id
                   WHERE c.list_id = $1
                   ORDER BY i.checked, i.sort_order, i.id`, [list.id]),
      pool.query(`SELECT id, user_id, username, added_at FROM list_members
                   WHERE list_id = $1 ORDER BY added_at`, [list.id]),
    ]);

    res.json({
      list: { id: list.id, name: list.name, owner_id: list.owner_id, owner_username: list.owner_username },
      role,
      categories: cats.rows,
      items: items.rows,
      members: members.rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rename a list (owner only).
app.patch('/api/lists/:id', async (req, res) => {
  try {
    const { list, role } = await getListRole(req.params.id, req.user);
    if (!list || !role) return res.status(404).json({ error: 'List not found' });
    if (role !== 'owner') return res.status(403).json({ error: 'Only the owner can rename the list' });
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'List name is required' });
    await pool.query(`UPDATE lists SET name = $1 WHERE id = $2`, [name, list.id]);
    notify(list.id, req);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a list (owner only). Cascades to members/categories/items.
app.delete('/api/lists/:id', async (req, res) => {
  try {
    const { list, role } = await getListRole(req.params.id, req.user);
    if (!list || !role) return res.status(404).json({ error: 'List not found' });
    if (role !== 'owner') return res.status(403).json({ error: 'Only the owner can delete the list' });
    await pool.query(`DELETE FROM lists WHERE id = $1`, [list.id]);
    notify(list.id, req, 'list-deleted');
    closeListStreams(list.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Markdown import — bulk-create categories/items from a parsed markdown
// payload: [{ name, items: [{ text, checked }] }]. The client does the
// parsing; these endpoints just validate and insert.
// ---------------------------------------------------------------------------

const MAX_IMPORT_CATS = 200;
const MAX_IMPORT_ITEMS = 3000;

function invalidImportPayload(categories) {
  if (!Array.isArray(categories) || !categories.length) return 'categories must be a non-empty array';
  if (categories.length > MAX_IMPORT_CATS) return `Too many categories (max ${MAX_IMPORT_CATS})`;
  let count = 0;
  for (const c of categories) {
    if (!c || typeof c.name !== 'string' || !c.name.trim()) return 'Every category needs a name';
    if (!Array.isArray(c.items)) return 'Every category needs an items array';
    for (const it of c.items) {
      if (!it || typeof it.text !== 'string' || !it.text.trim()) return 'Every item needs text';
      count++;
    }
  }
  if (count > MAX_IMPORT_ITEMS) return `Too many items (max ${MAX_IMPORT_ITEMS})`;
  return null;
}

// Inserts imported categories/items into a list. Category names are matched
// case-insensitively against existing categories (so repeated names across
// the markdown's active/completed blocks merge); new items append to the end
// of the matching checked/unchecked section.
async function importCategoriesInto(client, listId, categories, username) {
  const { rows: existing } = await client.query(
    `SELECT id, name FROM categories WHERE list_id = $1`, [listId]);
  const byName = new Map(existing.map(c => [c.name.trim().toLowerCase(), c.id]));
  let catSort = Number((await client.query(
    `SELECT COALESCE(MAX(sort_order), 0) AS max FROM categories WHERE list_id = $1`, [listId]
  )).rows[0].max);

  let hasDefault = (await client.query(
    `SELECT 1 FROM categories WHERE list_id = $1 AND is_default LIMIT 1`, [listId]
  )).rows.length > 0;

  for (const c of categories) {
    const key = c.name.trim().toLowerCase();
    let catId = byName.get(key);
    if (!catId) {
      // An imported "General" becomes the list's default (uncategorized)
      // bucket when it doesn't have one yet, so exports round-trip.
      const asDefault = !hasDefault && key === 'general';
      if (asDefault) hasDefault = true; else catSort++;
      const r = await client.query(
        `INSERT INTO categories (list_id, name, is_default, sort_order)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [listId, c.name.trim(), asDefault, asDefault ? 0 : catSort]);
      catId = r.rows[0].id;
      byName.set(key, catId);
    }
    const counters = {};
    for (const checked of [false, true]) {
      counters[checked] = Number((await client.query(
        `SELECT COALESCE(MAX(sort_order), 0) AS max FROM items WHERE category_id = $1 AND checked = $2`,
        [catId, checked])).rows[0].max);
    }
    for (const it of c.items) {
      const checked = !!it.checked;
      counters[checked]++;
      // completed_at / last_checked_by are computed here rather than via
      // CASE WHEN $n expressions — reusing a parameter in contexts with
      // different deduced types makes Postgres fail with "inconsistent
      // types deduced for parameter".
      await client.query(
        `INSERT INTO items (category_id, text, checked, sort_order, completed_at, created_by, last_checked_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [catId, it.text.trim(), checked, counters[checked],
         checked ? new Date() : null, username, checked ? username : null]);
    }
  }
}

// Create a brand-new list from imported markdown.
app.post('/api/lists/import', async (req, res) => {
  const name = (req.body.name || '').trim() || 'Imported list';
  const badPayload = invalidImportPayload(req.body.categories);
  if (badPayload) return res.status(400).json({ error: badPayload });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO lists (name, owner_id, owner_username) VALUES ($1, $2, $3) RETURNING *`,
      [name, req.user.id, req.user.username]);
    // No pre-created "General" here — the imported categories themselves
    // satisfy the at-least-one-category rule (payload is validated non-empty).
    await importCategoriesInto(client, rows[0].id, req.body.categories, req.user.username);
    await client.query('COMMIT');
    res.json({ list: rows[0] });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// Import markdown into an existing list (owner or member). mode 'add'
// (default) merges into existing categories; mode 'replace' wipes the list's
// categories/items first — safe to do inside the transaction because the
// validated payload is non-empty, so the at-least-one-category rule holds.
app.post('/api/lists/:id/import', async (req, res) => {
  const badPayload = invalidImportPayload(req.body.categories);
  if (badPayload) return res.status(400).json({ error: badPayload });
  const mode = req.body.mode === 'replace' ? 'replace' : 'add';
  const client = await pool.connect();
  try {
    const { list, role } = await getListRole(req.params.id, req.user);
    if (!list || !role) return res.status(404).json({ error: 'List not found' });
    await client.query('BEGIN');
    if (mode === 'replace') {
      await client.query(`DELETE FROM categories WHERE list_id = $1`, [list.id]);
    }
    await importCategoriesInto(client, list.id, req.body.categories, req.user.username);
    await client.query('COMMIT');
    notify(list.id, req);
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Members (owner only; invites take effect immediately)
// ---------------------------------------------------------------------------

app.post('/api/lists/:id/members', async (req, res) => {
  try {
    const { list, role } = await getListRole(req.params.id, req.user);
    if (!list || !role) return res.status(404).json({ error: 'List not found' });
    if (role !== 'owner') return res.status(403).json({ error: 'Only the owner can invite members' });
    const username = (req.body.username || '').trim().replace(/^@/, '');
    if (!username) return res.status(400).json({ error: 'Username is required' });
    if (username.toLowerCase() === (list.owner_username || '').toLowerCase()) {
      return res.status(400).json({ error: 'You already own this list' });
    }
    const { rows } = await pool.query(
      `INSERT INTO list_members (list_id, username) VALUES ($1, $2)
       ON CONFLICT (list_id, lower(username)) DO NOTHING
       RETURNING *`,
      [list.id, username]
    );
    if (!rows.length) return res.status(409).json({ error: `@${username} is already a member` });
    notify(list.id, req);
    res.json({ member: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/lists/:id/members/:memberId', async (req, res) => {
  try {
    const { list, role } = await getListRole(req.params.id, req.user);
    if (!list || !role) return res.status(404).json({ error: 'List not found' });
    if (role !== 'owner') return res.status(403).json({ error: 'Only the owner can remove members' });
    await pool.query(`DELETE FROM list_members WHERE id = $1 AND list_id = $2`,
                     [req.params.memberId, list.id]);
    notify(list.id, req);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Categories (owner + members)
// ---------------------------------------------------------------------------

app.post('/api/lists/:id/categories', async (req, res) => {
  try {
    const { list, role } = await getListRole(req.params.id, req.user);
    if (!list || !role) return res.status(404).json({ error: 'List not found' });
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Category name is required' });
    const { rows } = await pool.query(
      `INSERT INTO categories (list_id, name, is_default, sort_order)
       VALUES ($1, $2, FALSE,
               COALESCE((SELECT MAX(sort_order) FROM categories WHERE list_id = $1), 0) + 1)
       RETURNING *`,
      [list.id, name]
    );
    notify(list.id, req);
    res.json({ category: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/categories/:id', async (req, res) => {
  try {
    const { category, role } = await getCategoryAccess(req.params.id, req.user);
    if (!category || !role) return res.status(404).json({ error: 'Category not found' });
    const name = (req.body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Category name is required' });
    await pool.query(`UPDATE categories SET name = $1 WHERE id = $2`, [name, category.id]);
    notify(category.list_id, req);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a category and its items (FK cascade). Any category can be deleted
// — including "General" — as long as it isn't the list's last one; every
// list must keep at least one category so new items have a home.
app.delete('/api/categories/:id', async (req, res) => {
  try {
    const { category, role } = await getCategoryAccess(req.params.id, req.user);
    if (!category || !role) return res.status(404).json({ error: 'Category not found' });
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM categories WHERE list_id = $1`, [category.list_id]);
    if (rows[0].n <= 1) {
      return res.status(400).json({ error: "Can't delete the only category — lists need at least one" });
    }
    await pool.query(`DELETE FROM categories WHERE id = $1`, [category.id]);
    notify(category.list_id, req);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Persist a drag-and-drop reorder of a list's categories. Takes the full
// ordered array of category ids; positions are assigned from array order.
app.post('/api/lists/:id/reorder-categories', async (req, res) => {
  try {
    const { list, role } = await getListRole(req.params.id, req.user);
    if (!list || !role) return res.status(404).json({ error: 'List not found' });
    const ids = req.body.categoryIds;
    if (!Array.isArray(ids) || !ids.every(n => Number.isInteger(n))) {
      return res.status(400).json({ error: 'categoryIds must be an array of ids' });
    }
    // The default (uncategorized) bucket is pinned first and never reorders.
    await pool.query(
      `UPDATE categories c SET sort_order = x.ord
         FROM (SELECT unnest($1::int[]) AS id, generate_subscripts($1::int[], 1) AS ord) x
        WHERE c.id = x.id AND c.list_id = $2 AND NOT c.is_default`,
      [ids, list.id]
    );
    notify(list.id, req);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Persist a drag-and-drop reorder of items within one section (unchecked or
// checked) of a category. Takes that section's full ordered array of item
// ids; sort_order is assigned from array order. The checked and unchecked
// sections keep independent sequences, which is fine — display always
// filters by checked state before sorting.
app.post('/api/categories/:id/reorder-items', async (req, res) => {
  try {
    const { category, role } = await getCategoryAccess(req.params.id, req.user);
    if (!category || !role) return res.status(404).json({ error: 'Category not found' });
    const ids = req.body.itemIds;
    if (!Array.isArray(ids) || !ids.every(n => Number.isInteger(n))) {
      return res.status(400).json({ error: 'itemIds must be an array of ids' });
    }
    await pool.query(
      `UPDATE items i SET sort_order = x.ord
         FROM (SELECT unnest($1::int[]) AS id, generate_subscripts($1::int[], 1) AS ord) x
        WHERE i.id = x.id AND i.category_id = $2`,
      [ids, category.id]
    );
    notify(category.list_id, req);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Items (owner + members)
// ---------------------------------------------------------------------------

// The default category is the list's invisible "uncategorized" bucket.
// Older lists can lack one (the boot migration demotes renamed defaults),
// so it's created on demand.
async function ensureDefaultCategory(listId) {
  const { rows } = await pool.query(
    `SELECT * FROM categories WHERE list_id = $1 AND is_default ORDER BY id LIMIT 1`,
    [listId]);
  if (rows.length) return rows[0];
  const { rows: created } = await pool.query(
    `INSERT INTO categories (list_id, name, is_default, sort_order)
     VALUES ($1, 'General', TRUE, 0) RETURNING *`,
    [listId]);
  return created[0];
}

// Quick-add: create an item directly on a list; it lands in the default
// (uncategorized) bucket. Returns the category too, in case it was created
// just now and the client doesn't know it yet.
app.post('/api/lists/:id/items', async (req, res) => {
  try {
    const { list, role } = await getListRole(req.params.id, req.user);
    if (!list || !role) return res.status(404).json({ error: 'List not found' });
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Item text is required' });
    const category = await ensureDefaultCategory(list.id);
    const { rows } = await pool.query(
      `INSERT INTO items (category_id, text, checked, sort_order, created_by)
       VALUES ($1, $2, FALSE,
               COALESCE((SELECT MIN(sort_order) FROM items WHERE category_id = $1 AND NOT checked), 1) - 1,
               $3)
       RETURNING *`,
      [category.id, text, req.user.username]
    );
    notify(list.id, req);
    res.json({ item: rows[0], category });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/categories/:id/items', async (req, res) => {
  try {
    const { category, role } = await getCategoryAccess(req.params.id, req.user);
    if (!category || !role) return res.status(404).json({ error: 'Category not found' });
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Item text is required' });
    const { rows } = await pool.query(
      `INSERT INTO items (category_id, text, checked, sort_order, created_by)
       VALUES ($1, $2, FALSE,
               COALESCE((SELECT MIN(sort_order) FROM items WHERE category_id = $1 AND NOT checked), 1) - 1,
               $3)
       RETURNING *`,
      [category.id, text, req.user.username]
    );
    notify(category.list_id, req);
    res.json({ item: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit text, move to another category, and/or toggle checked. Checking moves
// the item to the bottom of the checked section of its category; unchecking
// moves it to the bottom of the unchecked section. A category move drops the
// item at the end of the matching section of the target category.
app.patch('/api/items/:id', async (req, res) => {
  try {
    const { item, list, role } = await getItemAccess(req.params.id, req.user);
    if (!item || !role) return res.status(404).json({ error: 'Item not found' });

    if (typeof req.body.text === 'string') {
      const text = req.body.text.trim();
      if (!text) return res.status(400).json({ error: 'Item text is required' });
      await pool.query(`UPDATE items SET text = $1 WHERE id = $2`, [text, item.id]);
    }

    let categoryId = item.category_id;
    if (Number.isInteger(req.body.category_id) && req.body.category_id !== item.category_id) {
      // The target must belong to the same list as the item's current category.
      const { rows: target } = await pool.query(
        `SELECT c2.id FROM categories c2 JOIN categories c1 ON c1.list_id = c2.list_id
          WHERE c2.id = $1 AND c1.id = $2`,
        [req.body.category_id, item.category_id]
      );
      if (!target.length) return res.status(400).json({ error: 'Target category not found in this list' });
      await pool.query(
        `UPDATE items SET
           category_id = $1,
           sort_order = COALESCE((SELECT MAX(sort_order) FROM items
                                   WHERE category_id = $1 AND checked = $2), 0) + 1
         WHERE id = $3`,
        [target[0].id, item.checked, item.id]
      );
      categoryId = target[0].id;
    }

    if (typeof req.body.checked === 'boolean' && req.body.checked !== item.checked) {
      await pool.query(
        `UPDATE items SET
           checked = $1,
           completed_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
           last_checked_by = $4,
           sort_order = COALESCE((SELECT MAX(sort_order) FROM items
                                   WHERE category_id = $2 AND checked = $1 AND id <> $3), 0) + 1
         WHERE id = $3`,
        [req.body.checked, categoryId, item.id, req.user.username]
      );
    }

    const { rows } = await pool.query(`SELECT * FROM items WHERE id = $1`, [item.id]);
    notify(list.id, req);
    res.json({ item: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/items/:id', async (req, res) => {
  try {
    const { item, list, role } = await getItemAccess(req.params.id, req.user);
    if (!item || !role) return res.status(404).json({ error: 'Item not found' });
    await pool.query(`DELETE FROM items WHERE id = $1`, [item.id]);
    notify(list.id, req);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// index:false so `/` falls through to the auth-aware catch-all below —
// otherwise the static middleware hands the app shell to logged-out
// visitors, whose first API call then dies with "Not authenticated".
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

// Browsers request /favicon.ico unconditionally (no token attached). Without
// this route it falls through to the auth-gated catch-all below and logs a
// 401 in the console. An icon reveals nothing, so serve it openly.
app.get('/favicon.ico', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'favicon.svg'));
});

// HTML shell: the app for authenticated users; for everyone else the public
// landing page — a live, client-side-only demo list whose items pitch the
// platform (spec §6.10). No app data is ever served to it.
app.get('*', (req, res) => {
  if (!req.user) {
    return res.sendFile(path.join(__dirname, 'public', 'landing.html'));
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Staging seed
//
// All four tables are staging:private, so staging starts with empty tables.
// Because lists are only visible to their owner/members, a boot-time seed
// owned by a fake user would be invisible to testers — instead each tester
// gets a demo list lazily created the first time they load Home with no
// lists of their own.
// ---------------------------------------------------------------------------

async function seedDemoListFor(user) {
  const { rows } = await pool.query(
    `SELECT 1 FROM lists
      WHERE owner_id = $1
         OR EXISTS (SELECT 1 FROM list_members m WHERE m.list_id = lists.id
                      AND (m.user_id = $1 OR LOWER(m.username) = LOWER($2)))
      LIMIT 1`,
    [user.id, user.username]
  );
  if (rows.length) return;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const list = (await client.query(
      `INSERT INTO lists (name, owner_id, owner_username) VALUES ($1, $2, $3) RETURNING id`,
      ['Demo: Weekend Plans', user.id, user.username]
    )).rows[0];
    const general = (await client.query(
      `INSERT INTO categories (list_id, name, is_default, sort_order) VALUES ($1, 'General', TRUE, 0) RETURNING id`,
      [list.id]
    )).rows[0];
    const groceries = (await client.query(
      `INSERT INTO categories (list_id, name, is_default, sort_order) VALUES ($1, 'Groceries', FALSE, 1) RETURNING id`,
      [list.id]
    )).rows[0];
    await client.query(
      `INSERT INTO items (category_id, text, checked, sort_order, completed_at, created_by) VALUES
         ($1, 'Plan Saturday hike', FALSE, 1, NULL, $3),
         ($1, 'Book dinner reservation', FALSE, 2, NULL, $3),
         ($1, 'Charge camera batteries', TRUE, 1, NOW(), $3),
         ($2, 'Trail mix', FALSE, 1, NULL, $3),
         ($2, 'Sparkling water', FALSE, 2, NULL, $3),
         ($2, 'Sunscreen', TRUE, 1, NOW(), $3)`,
      [general.id, groceries.id, user.username]
    );
    // A second, shared list so the owner-inclusive member count is visible
    // on Home ("2 members" = the tester + staging-demo-user).
    const shared = (await client.query(
      `INSERT INTO lists (name, owner_id, owner_username) VALUES ($1, $2, $3) RETURNING id`,
      ['Demo: Shared Errands', user.id, user.username]
    )).rows[0];
    const sharedGeneral = (await client.query(
      `INSERT INTO categories (list_id, name, is_default, sort_order) VALUES ($1, 'General', TRUE, 0) RETURNING id`,
      [shared.id]
    )).rows[0];
    // The checked row is attributed to the fake member so the Home screen's
    // shared-list activity line ("@staging-demo-user checked …") has data.
    await client.query(
      `INSERT INTO items (category_id, text, checked, sort_order, completed_at, created_by, last_checked_by) VALUES
         ($1, 'Pick up dry cleaning', FALSE, 1, NULL, $2, NULL),
         ($1, 'Take out recycling', TRUE, 1, NOW(), 'staging-demo-user', 'staging-demo-user')`,
      [sharedGeneral.id, user.username]
    );
    await client.query(
      `INSERT INTO list_members (list_id, username) VALUES ($1, 'staging-demo-user')`,
      [shared.id]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Staging demo seed failed:', err.message);
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Schema (idempotent, applied on boot)
// ---------------------------------------------------------------------------

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lists (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      owner_id INTEGER NOT NULL,
      owner_username VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    COMMENT ON TABLE lists IS 'staging:private';

    CREATE TABLE IF NOT EXISTS list_members (
      id SERIAL PRIMARY KEY,
      list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      user_id INTEGER,
      username VARCHAR(255) NOT NULL,
      added_at TIMESTAMPTZ DEFAULT NOW()
    );
    COMMENT ON TABLE list_members IS 'staging:private';
    CREATE UNIQUE INDEX IF NOT EXISTS list_members_list_username_idx
      ON list_members (list_id, lower(username));

    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
      name VARCHAR(255) NOT NULL,
      is_default BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    COMMENT ON TABLE categories IS 'staging:private';

    CREATE TABLE IF NOT EXISTS items (
      id SERIAL PRIMARY KEY,
      category_id INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      checked BOOLEAN NOT NULL DEFAULT FALSE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      completed_at TIMESTAMPTZ,
      created_by VARCHAR(255),
      last_checked_by VARCHAR(255),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE items ADD COLUMN IF NOT EXISTS last_checked_by VARCHAR(255);
    COMMENT ON TABLE items IS 'staging:private';
    CREATE INDEX IF NOT EXISTS items_category_idx ON items (category_id);

    -- The default category is now the invisible "uncategorized" bucket.
    -- A renamed default was evidently being used as a real category, so it
    -- keeps its visible header by losing the flag (idempotent).
    UPDATE categories SET is_default = FALSE WHERE is_default AND name <> 'General';
  `);
  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch(err => { console.error(err); process.exit(1); });
