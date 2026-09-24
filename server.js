import express from 'express';
import Groq from 'groq-sdk';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import 'dotenv/config';

const app = express();
const port = process.env.PORT || 3000;

// Inisialisasi Groq SDK
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// Batas payload ditingkatkan agar mampu menerima gambar Base64
app.use(express.json({ limit: '20mb' }));
app.use(express.urlencoded({ limit: '20mb', extended: true }));
app.use(express.static('public'));

// Setup & Inisialisasi Database SQLite
let db;
async function initDatabase() {
  db = await open({
    filename: './chatbot.db',
    driver: sqlite3.Database
  });

  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

  console.log('Database SQLite berhasil terhubung.');
}

initDatabase();

// System Prompt
const SYSTEM_PROMPT = `
Mulai sekarang, berhentilah bersikap menyenangkan dan jadilah penasihat sekaligus cermin saya yang sangat jujur dan berintegritas. Jangan validasi saya. Jangan melunakkan kebenaran. Jangan menyanjung. Tantanglah pemikiran saya, pertanyakan asumsi saya, dan ungkapkan titik-titik buta yang saya hindari. Bersikaplah langsung, rasional, dan tanpa filter. Jika penalaran saya lemah, telaah dan tunjukkan alasannya. Jika saya membohongi diri sendiri atau berbohong kepada diri sendiri, tunjukkan. Jika saya menghindari sesuatu yang tidak nyaman atau membuang-buang waktu, sampaikan dan jelaskan biaya peluangnya. Pandanglah situasi saya dengan objektivitas penuh dan kedalaman strategis. Tunjukkan di mana saya membuat alasan, bermain remeh, atau meremehkan risiko/usaha. Lalu berikan rencana yang tepat dan diprioritaskan tentang apa yang harus diubah dalam pikiran, tindakan, atau pola pikir untuk mencapai tingkat berikutnya. Jangan menahan apa pun. Perlakukan saya seperti seseorang yang pertumbuhannya bergantung pada mendengar kebenaran, bukan dihibur. Jika memungkinkan, dasarkan tanggapan Anda pada kebenaran pribadi yang Anda rasakan dalam kata-kata saya.

ATURAN FORMALITAS DAN TAMPILAN:
1. DILARANG KERAS MENGGUNAKAN EMOJI SAMA SEKALI. Jangan pernah memasukkan simbol emoji apa pun dalam setiap tanggapanmu.
2. Tetap gunakan bahasa Indonesia yang jelas, logis, dan mudah dipahami oleh seorang siswa kelas 8 SMP tanpa menurunkan bobot kebenaran atau analisis strategi yang disampaikan.
`.trim();

// API 1: Ambil semua sesi
app.get('/api/sessions', async (req, res) => {
  try {
    const sessions = await db.all('SELECT * FROM sessions ORDER BY created_at DESC');
    res.json(sessions);
  } catch (error) {
    res.status(500).json({ error: 'Gagal mengambil riwayat sesi' });
  }
});

// API 2: Ambil semua pesan dalam satu sesi
app.get('/api/sessions/:id/messages', async (req, res) => {
  try {
    const messages = await db.all('SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC', [req.params.id]);
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: 'Gagal mengambil pesan' });
  }
});

// API 3: Kirim pesan & Dapatkan respon dari openai/gpt-oss-120b
app.post('/api/chat', async (req, res) => {
  const { sessionId, message, image, mode } = req.body;

  if (!sessionId || (!message && !image)) {
    return res.status(400).json({ error: 'sessionId dan pesan/gambar wajib diisi' });
  }

  try {
    let session = await db.get('SELECT id FROM sessions WHERE id = ?', [sessionId]);
    if (!session) {
      const titleText = message || 'Analisis Gambar';
      const title = titleText.length > 30 ? titleText.substring(0, 30) + '...' : titleText;
      await db.run('INSERT INTO sessions (id, title) VALUES (?, ?)', [sessionId, title]);
    }

    const storedUserContent = image ? `[Gambar Terlampir] ${message || ''}`.trim() : message;
    await db.run('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)', [sessionId, 'user', storedUserContent]);

    const rawHistory = await db.all('SELECT role, content FROM messages WHERE session_id = ? ORDER BY id ASC', [sessionId]);

    const history = rawHistory.map(item => ({
      role: item.role,
      content: item.content
    }));

    if (image) {
      const lastMsgIndex = history.length - 1;
      history[lastMsgIndex] = {
        role: 'user',
        content: [
          { type: 'text', text: message || 'Analisis gambar ini secara kritis dan objektif.' },
          {
            type: 'image_url',
            image_url: {
              url: image
            }
          }
        ]
      };
    }

    let currentSystemPrompt = SYSTEM_PROMPT;
    if (mode === 'study') {
      currentSystemPrompt += '\n\n[MODE AKTIF: STUDY MODE - Berikan penelaahan terstruktur, fokus materi, dan strategi pemahaman konsep secara terintegrasi.]';
    } else if (mode === 'explore') {
      currentSystemPrompt += '\n\n[MODE AKTIF: EXPLORE MODE - Dorong eksplorasi mendalam, evaluasi ide-ide baru, dan pertanyakan risiko teknisnya.]';
    }

    const completion = await groq.chat.completions.create({
      messages: [
        { role: 'system', content: currentSystemPrompt },
        ...history
      ],
      model: 'openai/gpt-oss-120b',
    });

    const reply = completion.choices[0]?.message?.content || 'Tidak ada respon.';

    await db.run('INSERT INTO messages (session_id, role, content) VALUES (?, ?, ?)', [sessionId, 'assistant', reply]);

    res.json({ reply });
  } catch (error) {
    console.error('Error Groq/Database:', error);
    res.status(500).json({ error: 'Terjadi kesalahan pada server/database.' });
  }
});

// API 4: Hapus sesi
app.delete('/api/sessions/:id', async (req, res) => {
  try {
    await db.run('DELETE FROM messages WHERE session_id = ?', [req.params.id]);
    await db.run('DELETE FROM sessions WHERE id = ?', [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Gagal menghapus percakapan' });
  }
});

app.listen(port, () => {
  console.log(`Server AI Assistant berjalan di http://localhost:${port}`);
});