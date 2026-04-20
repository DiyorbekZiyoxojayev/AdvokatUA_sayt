'use strict';

const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const path       = require('path');
const crypto     = require('crypto');
require('dotenv').config();

const REQUIRED = ['GROQ_API_KEY'];
for (const key of REQUIRED) {
  if (!process.env[key]) {
    console.error(`[FATAL] Missing env var: ${key}`);
    process.exit(1);
  }
}

const app          = express();
const PORT         = process.env.PORT || 3000;
const PROD         = process.env.NODE_ENV === 'production';
const GROQ_API_KEY = process.env.GROQ_API_KEY;

const log = {
  info : (...a) => console.log ('[INFO]',  new Date().toISOString(), ...a),
  warn : (...a) => console.warn ('[WARN]',  new Date().toISOString(), ...a),
  error: (...a) => console.error('[ERROR]', new Date().toISOString(), ...a),
};

const VALID_TYPES = new Set(['ariza','shartnoma','shikoyat','pretenziya','vakola']);
const VALID_LANGS = new Set(['uzbek_latin','uzbek_cyrillic','russian','english']);
const VALID_NEWS_LANGS = new Set(['uz','oz','ru','en']);

function validateDoc(body) {
  const { type, lang, desc } = body || {};
  if (!desc || typeof desc !== 'string') return 'desc maydoni talab qilinadi';
  if (desc.trim().length < 10)           return 'Tavsif juda qisqa (kamida 10 belgi)';
  if (desc.length > 1500)                return 'Tavsif 1500 belgidan oshmasligi kerak';
  if (!VALID_TYPES.has(type))            return 'Noto\'g\'ri hujjat turi';
  if (!VALID_LANGS.has(lang))            return 'Noto\'g\'ri til';
  return null;
}

function sanitize(str, max = 2000) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, max)
    .replace(/[<>]/g, '')
    .replace(/javascript:/gi, '')
    .replace(/on\w+\s*=/gi, '');
}

class Cache {
  constructor(ttlMs) {
    this.ttl   = ttlMs;
    this.store = new Map();
    // Har 5 daqiqada eskirgan yozuvlarni tozalash
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.store) {
        if (now - v.ts > this.ttl) this.store.delete(k);
      }
    }, 5 * 60 * 1000).unref();
  }
  get(key) {
    const item = this.store.get(key);
    if (!item) return null;
    if (Date.now() - item.ts > this.ttl) { this.store.delete(key); return null; }
    return item.data;
  }
  set(key, data) { this.store.set(key, { data, ts: Date.now() }); }
}

const newsCache = new Cache(30 * 60 * 1000); // 30 daqiqa

async function groqChat(system, user, maxTokens = 1200, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method : 'POST',
      headers: {
        'Content-Type' : 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body  : JSON.stringify({
        model      : 'llama-3.3-70b-versatile',
        max_tokens : maxTokens,
        temperature: 0.7,
        messages   : [
          { role: 'system', content: system },
          { role: 'user',   content: user   },
        ],
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const err  = new Error('Groq API error');
      err.status = res.status;
      err.code   = body.error?.code || 'unknown';
      throw err;
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';

  } finally {
    clearTimeout(timer);
  }
}

function genNonce() {
  return crypto.randomBytes(16).toString('base64');
}

app.use((req, res, next) => {
  res.locals.nonce = genNonce();
  next();
});

app.use((req, res, next) => {
  const nonce = res.locals.nonce;
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc     : ["'self'"],
        scriptSrc      : ["'self'", `'nonce-${nonce}'`],
        styleSrc       : ["'self'", "'unsafe-inline'",
                          'https://fonts.googleapis.com',
                          'https://fonts.gstatic.com'],
        fontSrc        : ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc         : ["'self'", 'data:', 'https:', 'blob:'],
        connectSrc     : ["'self'", 'https://api.groq.com',
                          'https://*.onrender.com'],
        frameSrc       : ["'none'"],
        objectSrc      : ["'none'"],
        baseUri        : ["'self'"],
        formAction     : ["'self'"],
        upgradeInsecureRequests: PROD ? [] : null,
      },
    },
    crossOriginEmbedderPolicy  : false,
    crossOriginResourcePolicy  : { policy: 'cross-origin' },
    referrerPolicy             : { policy: 'strict-origin-when-cross-origin' },
    hsts                       : PROD ? { maxAge: 31536000, includeSubDomains: true } : false,
    noSniff                    : true,
    xssFilter                  : true,
    hidePoweredBy              : true,
  })(req, res, next);
});

app.set('trust proxy', 1);

const rawOrigins     = (process.env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
const allowedOrigins = new Set(['http://localhost:3000', ...rawOrigins]);

app.use(cors({
  origin(origin, cb) {
    if (!origin)                              return cb(null, true);
    if (origin.endsWith('.onrender.com'))     return cb(null, true);
    if (allowedOrigins.has(origin))           return cb(null, true);
    log.warn('CORS blocked:', origin);
    cb(new Error('CORS: not allowed'));
  },
  methods        : ['GET', 'POST', 'OPTIONS'],
  allowedHeaders : ['Content-Type'],
  credentials    : false,
}));

app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));

// Static files uchun maxsus CORS qoidasi
app.use(rateLimit({
  windowMs       : 15 * 60 * 1000,
  max            : 150,
  standardHeaders: true,
  legacyHeaders  : false,
  message        : { error: 'Juda ko\'p so\'rov. 15 daqiqadan so\'ng qayta urinib ko\'ring.' },
  skip           : (req) => req.path === '/health', // health check limitlanmasin
}));

// AI: 15 req / 5 daqiqa
const aiLimiter = rateLimit({
  windowMs       : 5 * 60 * 1000,
  max            : 15,
  message        : { error: 'AI limitiga yetdingiz. 5 daqiqadan so\'ng qayta urinib ko\'ring.' },
});


const fs = require('fs');
const indexPath = path.join(__dirname, 'public', 'index.html');
let indexTemplate = '';

try {
  indexTemplate = fs.readFileSync(indexPath, 'utf8');
  log.info('index.html o\'qildi, hajmi:', indexTemplate.length, 'belgi');
} catch (e) {
  log.error('index.html topilmadi:', e.message);
  process.exit(1);
}

// POST /api/document
app.post('/api/document', aiLimiter, async (req, res) => {
  const validErr = validateDoc(req.body);
  if (validErr) return res.status(400).json({ error: validErr });

  const { type, lang, desc } = req.body;
  const cleanDesc = sanitize(desc, 1500);
  const cleanType = sanitize(type, 100);
  const cleanLang = sanitize(lang, 100);

  const langMap = {
    uzbek_latin    : "O'zbek tilida (lotin alifbosi)",
    uzbek_cyrillic : 'Ўзбек тилида (кирилл алифбоси)',
    russian        : 'русском языке',
    english        : 'English',
  };
  const typeMap = {
    ariza      : 'ariza',
    shartnoma  : 'shartnoma',
    shikoyat   : 'shikoyat',
    pretenziya : 'pretenziya',
    vakola     : 'vakolatnoma',
  };

  try {
    const text = await groqChat(
      `Siz tajribali O'zbek advokati va huquqshunossiz. Faqat hujjat matnini bering, rasmiy uslubda. Bo'sh maydonlarni [___] bilan belgilang. HTML teglari ishlatmang.`,
      `${typeMap[cleanType] || cleanType} hujjatini ${langMap[cleanLang] || cleanLang} yozing:\n\nVaziyat: ${cleanDesc}`,
      1200
    );
    res.json({ text });

  } catch (err) {
    log.error('/api/document', { status: err.status, code: err.code });
    if (err.name === 'AbortError') return res.status(504).json({ error: 'So\'rov vaqti tugadi. Qayta urinib ko\'ring.' });
    if (err.status === 401)        return res.status(500).json({ error: 'API kaliti muammosi.' });
    if (err.status === 429)        return res.status(429).json({ error: 'AI limit. Biroz kuting.' });
    res.status(500).json({ error: 'Server xatosi. Keyinroq urinib ko\'ring.' });
  }
});

// GET /api/news
app.get('/api/news', async (req, res) => {
  const lang = VALID_NEWS_LANGS.has(req.query.lang) ? req.query.lang : 'uz';

  const cached = newsCache.get(lang);
  if (cached) return res.json(cached);

  const langInstr = {
    uz : "O'zbek tilida (lotin alifbosi) javob ber",
    oz : 'Ўзбек тилида (кирилл алифбоси) жавоб бер',
    ru : 'Отвечай на русском языке',
    en : 'Answer in English',
  };
  const cats = {
    uz : 'Qonunchilik, Soliq, Mehnat, Biznes, Oila, Jinoyat',
    oz : 'Қонунчилик, Солиқ, Меҳнат, Бизнес, Оила, Жиноят',
    ru : 'Законодательство, Налоги, Трудовое, Бизнес, Семья, Уголовное',
    en : 'Legislation, Tax, Labour, Business, Family, Criminal',
  };

  try {
    const raw = await groqChat(
      "Siz O'zbekiston huquqiy yangiliklar mutaxassisisiz. Faqat sof JSON qaytaring.",
      `${langInstr[lang]}. 6 ta yangilik. Format: [{"title":"...","desc":"...","cat":"...","date":"..."}]. Cat: ${cats[lang]}. date: 2024 yoki 2025.`,
      1000,
      15000
    );

    const cleaned = raw.replace(/```json|```/g, '').trim();
    const items   = JSON.parse(cleaned);

    const clean = items.slice(0, 6).map(n => ({
      title : sanitize(String(n.title || ''), 200),
      desc  : sanitize(String(n.desc  || ''), 400),
      cat   : sanitize(String(n.cat   || ''), 60),
      date  : sanitize(String(n.date  || ''), 40),
    }));

    newsCache.set(lang, clean);
    res.json(clean);

  } catch (err) {
    log.error('/api/news', { status: err.status, code: err.code });
    const stale = newsCache.get(lang);
    if (stale) return res.json(stale);
    res.status(500).json([]);
  }
});

// GET /health
app.get('/health', (_req, res) => {
  res.json({
    ok    : true,
    ts    : new Date().toISOString(),
    api   : 'Groq',
    uptime: Math.floor(process.uptime()),
    env   : {
      hasApiKey: !!process.env.GROQ_API_KEY,
      nodeEnv  : process.env.NODE_ENV || 'development',
      node     : process.version,
    },
  });
});


app.get('*', (req, res) => {
  const nonce = res.locals.nonce;
  // <script> → <script nonce="...">
  const html = indexTemplate.replace(/<script>/g, `<script nonce="${nonce}">`);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.use((err, _req, res, _next) => {
  log.error('Unhandled:', err.message);
  res.status(500).json({ error: 'Ichki server xatosi.' });
});


const server = app.listen(PORT, '0.0.0.0', () => {
  log.info(`Server: http://0.0.0.0:${PORT}`);
  log.info(`Groq API: ${GROQ_API_KEY ? '✅' : '❌'}`);
  log.info(`Rejim: ${PROD ? 'PRODUCTION' : 'DEVELOPMENT'}`);
});

process.on('SIGTERM', () => {
  log.info('SIGTERM — server to\'xtatilmoqda...');
  server.close(() => {
    log.info('Server to\'xtadi.');
    process.exit(0);
  });
});

process.on('uncaughtException', (err) => {
  log.error('uncaughtException:', err.message);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.error('unhandledRejection:', reason);
});
