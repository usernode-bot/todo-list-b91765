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
// Lists
// ---------------------------------------------------------------------------

// Home: lists the user owns or is a member of.
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
                WHERE c.list_id = l.id AND i.checked) AS done_count
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
                   WHERE list_id = $1 ORDER BY is_default DESC, sort_order, id`, [list.id]),
      pool.query(`SELECT i.id, i.category_id, i.text, i.checked, i.sort_order, i.completed_at, i.created_by
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
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
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
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a category: its items move to the list's default category.
// The default category itself can't be deleted.
app.delete('/api/categories/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const { category, role } = await getCategoryAccess(req.params.id, req.user);
    if (!category || !role) return res.status(404).json({ error: 'Category not found' });
    if (category.is_default) return res.status(400).json({ error: "The default category can't be deleted" });

    await client.query('BEGIN');
    const def = await client.query(
      `SELECT id FROM categories WHERE list_id = $1 AND is_default LIMIT 1`, [category.list_id]);
    const defaultId = def.rows[0].id;
    // Re-sequence moved items after the default category's existing ones,
    // keeping unchecked and checked orderings intact.
    await client.query(
      `UPDATE items SET
         category_id = $1,
         sort_order = sort_order + COALESCE((SELECT MAX(sort_order) FROM items WHERE category_id = $1), 0) + 1
       WHERE category_id = $2`,
      [defaultId, category.id]
    );
    await client.query(`DELETE FROM categories WHERE id = $1`, [category.id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// Items (owner + members)
// ---------------------------------------------------------------------------

app.post('/api/categories/:id/items', async (req, res) => {
  try {
    const { category, role } = await getCategoryAccess(req.params.id, req.user);
    if (!category || !role) return res.status(404).json({ error: 'Category not found' });
    const text = (req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Item text is required' });
    const { rows } = await pool.query(
      `INSERT INTO items (category_id, text, checked, sort_order, created_by)
       VALUES ($1, $2, FALSE,
               COALESCE((SELECT MAX(sort_order) FROM items WHERE category_id = $1 AND NOT checked), 0) + 1,
               $3)
       RETURNING *`,
      [category.id, text, req.user.username]
    );
    res.json({ item: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Edit text and/or toggle checked. Checking moves the item to the bottom of
// the checked section of its category; unchecking moves it to the bottom of
// the unchecked section.
app.patch('/api/items/:id', async (req, res) => {
  try {
    const { item, role } = await getItemAccess(req.params.id, req.user);
    if (!item || !role) return res.status(404).json({ error: 'Item not found' });

    if (typeof req.body.text === 'string') {
      const text = req.body.text.trim();
      if (!text) return res.status(400).json({ error: 'Item text is required' });
      await pool.query(`UPDATE items SET text = $1 WHERE id = $2`, [text, item.id]);
    }

    if (typeof req.body.checked === 'boolean' && req.body.checked !== item.checked) {
      await pool.query(
        `UPDATE items SET
           checked = $1,
           completed_at = CASE WHEN $1 THEN NOW() ELSE NULL END,
           sort_order = COALESCE((SELECT MAX(sort_order) FROM items
                                   WHERE category_id = $2 AND checked = $1 AND id <> $3), 0) + 1
         WHERE id = $3`,
        [req.body.checked, item.category_id, item.id]
      );
    }

    const { rows } = await pool.query(`SELECT * FROM items WHERE id = $1`, [item.id]);
    res.json({ item: rows[0] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/items/:id', async (req, res) => {
  try {
    const { item, role } = await getItemAccess(req.params.id, req.user);
    if (!item || !role) return res.status(404).json({ error: 'Item not found' });
    await pool.query(`DELETE FROM items WHERE id = $1`, [item.id]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated, otherwise an "open in Usernode"
// landing page so stray visits to the staging URL don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user) {
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Usernode</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Usernode</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="https://social-vibecoding.usernodelabs.org" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Go to Usernode</a>
  </div>
</body>`);
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
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    COMMENT ON TABLE items IS 'staging:private';
    CREATE INDEX IF NOT EXISTS items_category_idx ON items (category_id);
  `);
  app.listen(port, () => console.log(`Listening on :${port}`));
}

start().catch(err => { console.error(err); process.exit(1); });
