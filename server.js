'use strict';

const express   = require('express');
const helmet    = require('helmet');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const path      = require('path');
require('dotenv').config();

// ── API key tekshiruvi ────────────────────────────────────────────────────────
if (!process.env.GROQ_API_KEY) {
  console.error('❌ GROQ_API_KEY topilmadi!');
  console.error('Render → Environment → GROQ_API_KEY qo\'shing');
  process.exit(1);
}

const app  = express();
const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// ── Groq API chaqiruvi ────────────────────────────────────────────────────────
async function groqChat(systemPrompt, userPrompt, maxTokens = 1200) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: maxTokens,
      temperature: 0.7,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error(err.error?.message || 'Groq API xatosi'), { status: res.status });
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// ── Helmet CSP ────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      styleSrc:   ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://fonts.gstatic.com"],
      fontSrc:    ["'self'", "https://fonts.gstatic.com", "data:"],
      imgSrc:     ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "https://api.groq.com", "https://*.onrender.com"],
      frameSrc:   ["'none'"],
      objectSrc:  ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
}));

// ── CORS ──────────────────────────────────────────────────────────────────────
const rawOrigins = process.env.ALLOWED_ORIGINS || '';
const allowedOrigins = [
  'http://localhost:3000',
  ...rawOrigins.split(',').map(o => o.trim()).filter(Boolean),
];

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (origin.endsWith('.onrender.com')) return cb(null, true);
    if (allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error('CORS: ruxsat yo\'q'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
}));

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));

// ── Rate limiters ─────────────────────────────────────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false,
  trustProxy: true,
  message: { error: 'Juda ko\'p so\'rov. 15 daqiqadan so\'ng qayta urinib ko\'ring.' },
}));

const aiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 20,
  trustProxy: true,
  message: { error: 'AI limitiga yetdingiz. 5 daqiqadan so\'ng qayta urinib ko\'ring.' },
});

// ── Input sanitizer ───────────────────────────────────────────────────────────
function sanitize(str, maxLen = 2000) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen)
    .replace(/[<>]/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '');
}

// ── News cache (30 daqiqa) ────────────────────────────────────────────────────
const newsCache = new Map();
const CACHE_TTL = 30 * 60 * 1000;

// ── Static fayllar ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  etag: true,
  lastModified: true,
  maxAge: PROD ? '1h' : 0,
}));

// ════════════════════════════════════════════════════════════════════════════════
// POST /api/document — Hujjat yaratish
// ════════════════════════════════════════════════════════════════════════════════
app.post('/api/document', aiLimiter, async (req, res) => {
  try {
    const { type, lang, desc } = req.body;

    if (!desc || typeof desc !== 'string' || desc.trim().length < 10) {
      return res.status(400).json({ error: 'Vaziyatni to\'liqroq tasvirlab bering.' });
    }

    const cleanDesc = sanitize(desc, 1500);
    const cleanType = sanitize(type || 'ariza', 100);
    const cleanLang = sanitize(lang || "O'zbek tilida", 100);

    const text = await groqChat(
      `Siz tajribali O'zbek advokati va huquqshunossiz. Huquqiy hujjatlar uchun namuna matnlar tayyorlaysiz. Faqat hujjat matnini bering, rasmiy uslubda. Bo'sh maydonlarni [___] bilan belgilang. HTML teglari ishlatmang.`,
      `${cleanType} hujjatini ${cleanLang} yozing:\n\nVaziyat: ${cleanDesc}`,
      1200
    );

    res.json({ text });

  } catch (err) {
    console.error('[/api/document] xato:', err.status, err.message);
    if (err.status === 401) {
      return res.status(500).json({ error: 'Groq API kaliti noto\'g\'ri. Render → Environment ni tekshiring.' });
    }
    if (err.status === 429) {
      return res.status(429).json({ error: 'Groq limit. Bir oz kuting.' });
    }
    res.status(500).json({ error: 'Server xatosi. Keyinroq urinib ko\'ring.' });
  }
});

// ════════════════════════════════════════════════════════════════════════════════
// GET /api/news?lang=uz — Yangiliklar
// ════════════════════════════════════════════════════════════════════════════════
app.get('/api/news', async (req, res) => {
  const validLangs = ['uz', 'oz', 'ru', 'en'];
  const lang = validLangs.includes(req.query.lang) ? req.query.lang : 'uz';
  const cacheKey = `news_${lang}`;

  // Keshdan qaytarish
  if (newsCache.has(cacheKey)) {
    const { data, ts } = newsCache.get(cacheKey);
    if (Date.now() - ts < CACHE_TTL) {
      return res.json(data);
    }
  }

  const langInstructions = {
    uz: "O'zbek tilida (lotin alifbosi) javob ber",
    oz: "Ўзбек тилида (кирилл алифбоси) жавоб бер",
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
    const raw = await groqChat(
      "Siz O'zbekiston huquqiy yangiliklar mutaxassisisiz. Faqat sof JSON qaytaring, boshqa hech narsa yozmang. Markdown ham yozmang.",
      `${langInstructions[lang]}. O'zbekiston qonunchiligi va huquqiy sohada so'nggi yangiliklar haqida 6 ta qisqa yangilik. Format: [{"title":"...","desc":"...","cat":"...","date":"..."}]. Cat qiymatlari faqat: ${catList[lang]}. date: 2024 yoki 2025.`,
      1000
    );

    const cleaned = raw.replace(/```json|```/g, '').trim();
    const items = JSON.parse(cleaned);

    const clean = items.slice(0, 6).map(n => ({
      title: sanitize(String(n.title || ''), 200),
      desc:  sanitize(String(n.desc  || ''), 400),
      cat:   sanitize(String(n.cat   || ''), 60),
      date:  sanitize(String(n.date  || ''), 40),
    }));

    newsCache.set(cacheKey, { data: clean, ts: Date.now() });
    res.json(clean);

  } catch (err) {
    console.error('[/api/news] xato:', err.status, err.message);
    if (newsCache.has(cacheKey)) {
      return res.json(newsCache.get(cacheKey).data);
    }
    res.status(500).json([]);
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    ts: new Date().toISOString(),
    api: 'Groq',
    env: {
      hasApiKey: !!process.env.GROQ_API_KEY,
      nodeEnv: process.env.NODE_ENV || 'development',
    }
  });
});

// ── SPA fallback ──────────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Global xato handler ───────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[unhandled]', err.message);
  res.status(500).json({ error: 'Ichki server xatosi.' });
});

// ── Serverni ishga tushirish ──────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ AdvokatUA (Groq) server: http://0.0.0.0:${PORT}`);
  console.log(`🔑 Groq API: ${process.env.GROQ_API_KEY ? '✅ topildi' : '❌ YO\'Q!'}`);
  console.log(`🌍 Rejim: ${PROD ? 'PRODUCTION' : 'DEVELOPMENT'}`);
});
