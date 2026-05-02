const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASS || 'TilkiAdmin2024';

// ─── Database Setup ───────────────────────────────────────────────────────────
const db = new Database('tilki_game.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    age INTEGER DEFAULT 0,
    high_score INTEGER DEFAULT 0,
    total_eggs INTEGER DEFAULT 0,
    selected_character TEXT DEFAULT 'orange_fox',
    selected_costume TEXT DEFAULT 'none',
    daily_reward_day INTEGER DEFAULT 1,
    last_daily_claim TEXT DEFAULT NULL,
    mud_immunity INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS owned_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    item_type TEXT NOT NULL,
    item_id TEXT NOT NULL,
    purchased_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, item_type, item_id),
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    score INTEGER NOT NULL,
    eggs_collected INTEGER DEFAULT 0,
    played_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS daily_rewards (
    day INTEGER PRIMARY KEY,
    eggs INTEGER NOT NULL
  );
`);

// Seed daily rewards
const rewardCheck = db.prepare('SELECT COUNT(*) as cnt FROM daily_rewards').get();
if (rewardCheck.cnt === 0) {
  const rewards = [50, 75, 100, 150, 200, 250, 500];
  const ins = db.prepare('INSERT INTO daily_rewards (day, eggs) VALUES (?, ?)');
  rewards.forEach((eggs, i) => ins.run(i + 1, eggs));
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getUser(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ─── Auth / Register ──────────────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  const { username, age } = req.body;
  if (!username || username.trim().length < 2) {
    return res.json({ success: false, error: 'Kullanıcı adı en az 2 karakter olmalı.' });
  }
  try {
    db.prepare('INSERT INTO users (username, age) VALUES (?, ?)').run(username.trim(), age || 0);
    const user = getUser(username.trim());
    // Auto-own default character
    db.prepare('INSERT OR IGNORE INTO owned_items (user_id, item_type, item_id) VALUES (?, ?, ?)')
      .run(user.id, 'character', 'orange_fox');
    res.json({ success: true, user: sanitizeUser(user) });
  } catch (e) {
    if (e.message.includes('UNIQUE')) {
      const user = getUser(username.trim());
      if (user) return res.json({ success: true, user: sanitizeUser(user) });
    }
    res.json({ success: false, error: e.message });
  }
});

app.post('/api/login', (req, res) => {
  const { username } = req.body;
  const user = getUser(username);
  if (!user) return res.json({ success: false, error: 'Kullanıcı bulunamadı.' });
  const items = db.prepare('SELECT * FROM owned_items WHERE user_id = ?').all(user.id);
  res.json({ success: true, user: sanitizeUser(user), owned: items });
});

app.get('/api/user/:username', (req, res) => {
  const user = getUser(req.params.username);
  if (!user) return res.json({ success: false });
  const items = db.prepare('SELECT * FROM owned_items WHERE user_id = ?').all(user.id);
  res.json({ success: true, user: sanitizeUser(user), owned: items });
});

// ─── Score ────────────────────────────────────────────────────────────────────
app.post('/api/score', (req, res) => {
  const { username, score, eggs_collected } = req.body;
  const user = getUser(username);
  if (!user) return res.json({ success: false });
  db.prepare('INSERT INTO scores (user_id, score, eggs_collected) VALUES (?, ?, ?)').run(user.id, score, eggs_collected || 0);
  const newEggs = user.total_eggs + (eggs_collected || 0);
  const newHigh = Math.max(user.high_score, score);
  db.prepare('UPDATE users SET total_eggs = ?, high_score = ? WHERE id = ?').run(newEggs, newHigh, user.id);
  const updated = getUser(username);
  res.json({ success: true, user: sanitizeUser(updated) });
});

// ─── Daily Reward ─────────────────────────────────────────────────────────────
app.post('/api/daily-reward', (req, res) => {
  const { username } = req.body;
  const user = getUser(username);
  if (!user) return res.json({ success: false });
  const todayStr = today();
  if (user.last_daily_claim === todayStr) {
    return res.json({ success: false, error: 'Bugün zaten ödülünü aldın!', claimed: true });
  }
  const day = user.daily_reward_day;
  const reward = db.prepare('SELECT * FROM daily_rewards WHERE day = ?').get(day) || { eggs: 50 };
  const nextDay = (day % 7) + 1;
  const newEggs = user.total_eggs + reward.eggs;
  db.prepare('UPDATE users SET total_eggs = ?, daily_reward_day = ?, last_daily_claim = ? WHERE id = ?')
    .run(newEggs, nextDay, todayStr, user.id);
  const updated = getUser(username);
  res.json({ success: true, eggs: reward.eggs, day, newTotal: newEggs, user: sanitizeUser(updated) });
});

// ─── Shop / Buy ───────────────────────────────────────────────────────────────
app.post('/api/buy', (req, res) => {
  const { username, item_type, item_id, price } = req.body;
  const user = getUser(username);
  if (!user) return res.json({ success: false });
  if (user.total_eggs < price) {
    return res.json({ success: false, error: 'Yeterli yumurtan yok!' });
  }
  try {
    db.prepare('INSERT INTO owned_items (user_id, item_type, item_id) VALUES (?, ?, ?)').run(user.id, item_type, item_id);
    db.prepare('UPDATE users SET total_eggs = ? WHERE id = ?').run(user.total_eggs - price, user.id);
    const updated = getUser(username);
    res.json({ success: true, user: sanitizeUser(updated) });
  } catch (e) {
    res.json({ success: false, error: 'Zaten sahipsin.' });
  }
});

app.post('/api/equip', (req, res) => {
  const { username, item_type, item_id } = req.body;
  const user = getUser(username);
  if (!user) return res.json({ success: false });
  if (item_type === 'character') {
    db.prepare('UPDATE users SET selected_character = ? WHERE id = ?').run(item_id, user.id);
  } else if (item_type === 'costume') {
    db.prepare('UPDATE users SET selected_costume = ? WHERE id = ?').run(item_id, user.id);
  }
  const updated = getUser(username);
  res.json({ success: true, user: sanitizeUser(updated) });
});

// ─── Leaderboard ──────────────────────────────────────────────────────────────
app.get('/api/leaderboard', (req, res) => {
  const rows = db.prepare(`
    SELECT u.username, u.high_score, u.total_eggs, u.selected_character
    FROM users u
    ORDER BY u.high_score DESC
    LIMIT 20
  `).all();
  res.json({ success: true, leaderboard: rows });
});

// ─── Daily Reward Info ────────────────────────────────────────────────────────
app.get('/api/daily-rewards', (req, res) => {
  const rewards = db.prepare('SELECT * FROM daily_rewards ORDER BY day').all();
  res.json({ success: true, rewards });
});

// ─── Admin Panel API ──────────────────────────────────────────────────────────
function adminAuth(req, res, next) {
  const pass = req.headers['x-admin-password'] || req.query.pass;
  if (pass !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Yetkisiz erişim.' });
  next();
}

app.get('/api/admin/stats', adminAuth, (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) as cnt FROM users').get().cnt;
  const totalGames = db.prepare('SELECT COUNT(*) as cnt FROM scores').get().cnt;
  const totalEggsEver = db.prepare('SELECT COALESCE(SUM(eggs_collected),0) as total FROM scores').get().total;
  const topScore = db.prepare('SELECT MAX(high_score) as top FROM users').get().top;
  res.json({ totalUsers, totalGames, totalEggsEver, topScore });
});

app.get('/api/admin/users', adminAuth, (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY high_score DESC').all();
  res.json({ users });
});

app.get('/api/admin/user/:id', adminAuth, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.json({ error: 'Kullanıcı bulunamadı' });
  const items = db.prepare('SELECT * FROM owned_items WHERE user_id = ?').all(user.id);
  const scores = db.prepare('SELECT * FROM scores WHERE user_id = ? ORDER BY played_at DESC LIMIT 20').all(user.id);
  res.json({ user, items, scores });
});

app.post('/api/admin/give-eggs', adminAuth, (req, res) => {
  const { user_id, amount } = req.body;
  db.prepare('UPDATE users SET total_eggs = total_eggs + ? WHERE id = ?').run(amount, user_id);
  res.json({ success: true });
});

app.post('/api/admin/reset-score', adminAuth, (req, res) => {
  const { user_id } = req.body;
  db.prepare('UPDATE users SET high_score = 0 WHERE id = ?').run(user_id);
  res.json({ success: true });
});

app.delete('/api/admin/user/:id', adminAuth, (req, res) => {
  db.prepare('DELETE FROM owned_items WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM scores WHERE user_id = ?').run(req.params.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/recent-scores', adminAuth, (req, res) => {
  const scores = db.prepare(`
    SELECT s.*, u.username FROM scores s
    JOIN users u ON u.id = s.user_id
    ORDER BY s.played_at DESC LIMIT 50
  `).all();
  res.json({ scores });
});

// ─── Catch-all ────────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function sanitizeUser(u) {
  const { ...safe } = u;
  return safe;
}

app.listen(PORT, () => {
  console.log(`🦊 Tilki Kaçışı Sunucusu çalışıyor: http://localhost:${PORT}`);
  console.log(`🔐 Admin Paneli: http://localhost:${PORT}/admin.html`);
  console.log(`🔑 Admin Şifre: ${ADMIN_PASSWORD}`);
});
