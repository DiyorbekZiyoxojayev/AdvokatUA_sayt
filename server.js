/**
 * AdvokatUA — Secure Backend Server
 * Node.js + Express
 * 
 * Himoya:
 *  ✅ API kaliti .env da yashiringan (hech qachon frontendga chiqmaydi)
 *  ✅ Helmet — HTTP security headers
 *  ✅ CORS — faqat o'z domeningizdan so'rovlar
 *  ✅ Rate limiting — IP bo'yicha cheklash
 *  ✅ Input validation & sanitization
 *  ✅ Request size limit
 *  ✅ Error leak oldini olish
 *  ✅ News caching — 30 daqiqa (API chaqiruvlarni kamaytiradi)
 */

'use strict';

const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const Anthropic  = require('@anthropic-ai/sdk');
require('dotenv').config();

// ── Validate required env vars ──────────────────────────────────────────────
const REQUIRED_ENV = ['ANTHROPIC_API_KEY'];
REQUIRED_ENV.forEach(k => {
  if (!process.env[k]) {
    console.error(`❌ Missing environment variable: ${k}`);
    process.exit(1);
  }
});

const app    = express();
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const PORT   = process.env.PORT || 3000;
const PROD   = process.env.NODE_ENV === 'production';

// ── Security Headers (Helmet) ────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com"],
      imgSrc:     ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      frameSrc:   ["'none'"],
      objectSrc:  ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// ── CORS — faqat o'z saytingizdan ────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000').split(',');
app.use(cors({
  origin(origin, cb) {
    // Allow same-origin requests (no origin header) and allowed list
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS: not allowed'));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));

// ── Body parsing — max 20kb ──────────────────────────────────────────────────
app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));

// ── Global rate limiter: 100 req / 15 min per IP ─────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Juda ko\'p so\'rov. 15 daqiqadan so\'ng qayta urinib ko\'ring.' },
}));

// ── AI endpoints rate limiter: 10 req / 5 min per IP ─────────────────────────
const aiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 10,
  message: { error: 'AI limitiga yetdingiz. 5 daqiqadan so\'ng qayta urinib ko\'ring.' },
});

// ── Sanitize string input ─────────────────────────────────────────────────────
function sanitize(str, maxLen = 2000) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen)
    .replace(/[<>]/g, '') // strip angle brackets
    .replace(/javascript:/gi, '') // strip js: proto
    .replace(/on\w+\s*=/gi, ''); // strip event handlers
}

// ── Simple in-memory news cache (30 min) ────────────────────────────────────
const newsCache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

// ── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  maxAge: PROD ? '1d' : 0,
}));

// ═══════════════════════════════════════════════════════════════════════════════
// API: POST /api/document — hujjat yaratish
// ═══════════════════════════════════════════════════════════════════════════════
app.post('/api/document', aiLimiter, async (req, res) => {
  try {
    const { type, lang, desc } = req.body;

    // Validation
    if (!desc || typeof desc !== 'string') {
      return res.status(400).json({ error: 'desc maydoni talab qilinadi.' });
    }
    const cleanDesc = sanitize(desc, 1500);
    const cleanType = sanitize(type, 100);
    const cleanLang = sanitize(lang, 100);

    if (cleanDesc.length < 10) {
      return res.status(400).json({ error: 'Tavsif juda qisqa.' });
    }

    const message = await client.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1200,
      system:     `Siz tajribali O'zbek advokati va huquqshunossiz. Huquqiy hujjatlar uchun namuna matnlar tayyorlaysiz. Faqat hujjat matnini bering, rasmiy uslubda, bo'sh maydonlarni [___] bilan belgilang. HTML teglari ishlatmang.`,
      messages: [{
        role:    'user',
        content: `${cleanType} hujjatini ${cleanLang} yozing:\n\nVaziyat: ${cleanDesc}`,
      }],
    });

    const text = message.content?.map(b => b.type === 'text' ? b.text : '').join('') || '';
    res.json({ text });

  } catch (err) {
    console.error('[/api/document]', err.message);
    // Don't leak internal errors to client
    res.status(500).json({ error: 'Server xatosi. Keyinroq urinib ko\'ring.' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// API: GET /api/news?lang=uz — qonunchilik yangiliklari
// ═══════════════════════════════════════════════════════════════════════════════
app.get('/api/news', async (req, res) => {
  const lang = ['uz','oz','ru','en'].includes(req.query.lang) ? req.query.lang : 'uz';
  const cacheKey = `news_${lang}`;

  // Return cached if fresh
  if (newsCache.has(cacheKey)) {
    const { data, ts } = newsCache.get(cacheKey);
    if (Date.now() - ts < CACHE_TTL) {
      return res.json(data);
    }
  }

  const langInstructions = {
    uz: "O'zbek tilida (lotin) javob ber",
    oz: "Ўзбек тилида (кирилл) жавоб бер",
    ru: "Отвечай на русском языке",
    en: "Answer in English",
  };
  const catList = {
    uz: "Qonunchilik, Soliq, Mehnat, Biznes, Oila, Jinoyat",
    oz: "Қонунчилик, Солиқ, Меҳнат, Бизнес, Оила, Жиноят",
    ru: "Законодательство, Налоги, Трудовое, Бизнес, Семья, Уголовное",
    en: "Legislation, Tax, Labour, Business, Family, Criminal",
  };

  try {
    const message = await client.messages.create({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 1400,
      system:     'Siz O\'zbekiston huquqiy yangiliklar mutaxassisisiz. Faqat sof JSON qaytaring, markdown yoki izoh yozmang.',
      messages: [{
        role:    'user',
        content: `${langInstructions[lang]}. O'zbekiston qonunchiligi va huquqiy sohada so'nggi yangiliklar haqida 6 ta qisqa yangilik tuzib ber. Har biri uchun: title (sarlavha), desc (2 jumladan iborat tavsif), cat (quyidagilardan biri: ${catList[lang]}), date (2024 yoki 2025). Faqat JSON massiv: [{"title":"...","desc":"...","cat":"...","date":"..."}]`,
      }],
    });

    let raw = message.content?.map(b => b.type === 'text' ? b.text : '').join('') || '[]';
    raw = raw.replace(/```json|```/g, '').trim();
    const items = JSON.parse(raw);

    // Validate shape
    const clean = items.slice(0, 6).map(n => ({
      title: sanitize(String(n.title || ''), 200),
      desc:  sanitize(String(n.desc  || ''), 400),
      cat:   sanitize(String(n.cat   || ''), 60),
      date:  sanitize(String(n.date  || ''), 40),
    }));

    newsCache.set(cacheKey, { data: clean, ts: Date.now() });
    res.json(clean);

  } catch (err) {
    console.error('[/api/news]', err.message);
    // Return cached stale data if available
    if (newsCache.has(cacheKey)) {
      return res.json(newsCache.get(cacheKey).data);
    }
    res.status(500).json([]);
  }
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ── 404 → index.html (SPA) ───────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Global error handler (never leak stack traces) ───────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err.message);
  res.status(500).json({ error: 'Ichki server xatosi.' });
});

app.listen(PORT, () => {
  console.log(`✅ AdvokatUA server ishga tushdi: http://localhost:${PORT}`);
  console.log(`🔒 Rejim: ${PROD ? 'PRODUCTION' : 'DEVELOPMENT'}`);
});
