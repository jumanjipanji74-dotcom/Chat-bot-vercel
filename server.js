import express from 'express';
import Groq from 'groq-sdk';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import bcrypt from 'bcryptjs';
import session from 'express-session';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 3000;

// Wajib untuk Railway agar pembacaan IP/Proxy dan Cookie aman
app.set('trust proxy', 1);

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));

// Konfigurasi Session yang ramah Railway & Cookie lintas aman
app.use(session({
  secret: process.env.SESSION_SECRET || 'kunci_rahasia_sangat_aman_123',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: process.env.NODE_ENV === 'production', // Otomatis true di Railway (HTTPS)
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 7 * 24 * 60 * 60 * 1000 
  }
}));

let db;
async function initDatabase() {
  db = await open({ filename: './chatbot.db', driver: sqlite3.Database });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
    );
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (session_id) REFERENCES sessions (id) ON DELETE CASCADE
    );
  `);
  console.log('Database SQLite dengan Autentikasi berhasil terhubung.');
}
initDatabase();

// Middleware Cek Auth untuk API
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

// Middleware Proteksi Halaman HTML Utama
function redirectIfNotAuth(req, res, next) {
  if (!req.session.userId) {
    return res.sendFile(path.join(__dirname, 'public', 'login.html'));
  }
  next();
}

// Sajikan halaman login secara langsung jika diakses
app.get('/login.html', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Proteksi halaman utama index.html (Harus login dulu baru bisa akses)
app.get('/', redirectIfNotAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Folder statis untuk asset lain
app.use(express.static('public'));

const BASE_SYSTEM_PROMPT = `
Mulai sekarang, berhentilah bersikap menyenangkan dan jadilah penasihat sekaligus cermin saya yang sangat jujur dan berintegritas. Jangan validasi saya. Jangan melunakkan kebenaran. Jangan menyanjung. Tantanglah pemikiran saya, pertanyakan asumsi saya, dan ungkapkan titik-titik buta yang saya hindari. Bersikaplah langsung, rasional, dan tanpa filter. Jika penalaran saya lemah, telaah dan tunjukkan alasannya. Jika saya membohongi diri sendiri atau berbohong kepada diri sendiri, tunjukkan. Jika saya menghindari sesuatu yang tidak nyaman atau membuang-buang waktu, sampaikan dan jelaskan biaya peluangnya. Pandanglah situasi saya dengan objektivitas penuh dan kedalaman strategis. Tunjukkan di mana saya membuat alasan, bermain remeh, atau meremehkan risiko/usaha. Lalu berikan rencana yang tepat dan diprioritaskan tentang apa yang harus diubah dalam pikiran, tindakan, atau pola pikir untuk mencapai tingkat berikutnya. Jangan menahan apa pun. Perlakukan saya seperti seseorang yang pertumbuhannya bergantung pada mendengar kebenaran, bukan dihibur.

ATURAN FORMALITAS DAN TAMPILAN:
1. DILARANG KERAS MENGGUNAKAN EMOJI SAMA SEKALI.
2. JAWAB DENGAN SANGAT SINGKAT, PADAT, DAN LANGSUNG PADA INTI (TO THE POINT).
`.trim();

// API Auth Routes
app.post('/api/auth/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username dan password wajib diisi' });
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await db.run('INSERT INTO users (username, password) VALUES (?, ?)', [username, hashedPassword]);
    req.session.userId = result.lastID;
    req.session.username = username;
    res.json({ success: true });
  } catch (error) {
    res.status(400).json({ error: 'Username sudah digunakan' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Username atau password salah' });
    }
    req.session.userId = user.id;
    req.session.username = user.username;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Gagal login' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ success: true }));
});

app.get('/api/auth/status', (req, res) => {
  if (req.session.userId) res.json({ loggedIn: true, username: req.session.username });
  else res.json({ loggedIn: false });
});

// API Chat & Session Routes
app.get('/api/sessions', requireAuth, async (req, res) => {
  const sessions = await db.all('SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC', [req.session.userId]);
  res.json(sessions);
});

app.get('/api/sessions/:id/messages', requireAuth, async (req, res) => {
  const session = await db.get('SELECT id FROM sessions WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId]);
  if (!session) return res.status(403).json({ error: 'Akses ditolak' });
  const messages = await db.all('SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC', [req.params.id]);
  res.json(messages);
});

app.post('/api/chat', requireAuth, async (req, res) => {
  const { sessionId, message, persona, mode } = req.body;
  if (!sessionId || !message) return res.status(400).json({ error: 'Data tidak lengkap' });

  try {
    let session = await db.get('SELECT id FROM sessions WHERE id = ? AND user_id = ?', [sessionId, req.session.userId]);
    if (!session) {
      const title = message.length > 30 ? message.substring(0, 30) + '...' : message;
      await db.run('INSERT INTO sessions (id, user_id, title) VALUES (?, ?, ?)', [sessionId, req.session.userId, title]);
    }

    await db.run('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)', [sessionId, 'user', message]);
    const rawHistory = await db.all('SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC', [sessionId]);
    const history = rawHistory.map(item => ({ role: item.role, content: item.content }));

    let currentSystemPrompt = BASE_SYSTEM_PROMPT;
    if (persona === 'formal') currentSystemPrompt += '\n\n[PERSONA: Gunakan bahasa profesional dan terstruktur.]';
    else if (persona === 'santai') currentSystemPrompt += '\n\n[PERSONA: Gunakan bahasa sehari-hari yang akrab.]';
    else if (persona === 'singkat') currentSystemPrompt += '\n\n[PERSONA: Jawab langsung ke inti, tanpa basa-basi.]';
    else if (persona === 'detail') currentSystemPrompt += '\n\n[PERSONA: Berikan jawaban lengkap dengan konteks dan contoh.]';

    if (mode === 'study') currentSystemPrompt += '\n\n[MODE: Study Mode - Berikan penelaahan terstruktur.]';
    else if (mode === 'explore') currentSystemPrompt += '\n\n[MODE: Explore Mode - Dorong eksplorasi mendalam.]';

    const completion = await groq.chat.completions.create({
      messages: [{ role: 'system', content: currentSystemPrompt }, ...history],
      model: 'openai/gpt-oss-120b',
    });

    const reply = completion.choices[0]?.message?.content || 'Tidak ada respon.';
    await db.run('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)', [sessionId, 'assistant', reply]);

    res.json({ reply });
  } catch (error) {
    res.status(500).json({ error: 'Kesalahan server' });
  }
});

app.delete('/api/sessions/:id', requireAuth, async (req, res) => {
  const session = await db.get('SELECT id FROM sessions WHERE id = ? AND user_id = ?', [req.params.id, req.session.userId]);
  if (!session) return res.status(403).json({ error: 'Akses ditolak' });
  await db.run('DELETE FROM messages WHERE session_id = ?', [req.params.id]);
  await db.run('DELETE FROM sessions WHERE id = ?', [req.params.id]);
  res.json({ success: true });
});

app.listen(port, () => console.log(`Server berjalan di http://localhost:${port}`));