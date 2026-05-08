# AdvokatUA — O'rnatish qo'llanmasi

## Fayl strukturasi

```
advokatua/
├── public/
│   └── index.html      ← Sayt (bu yerga ko'chiring)
├── server.js           ← Backend server
├── package.json
├── .env.example        ← Namuna env fayli
├── .env                ← ⚠️ O'zingiz yaratasiz (Git ga yuklamang!)
└── .gitignore
```

## 1-qadam: Faylni joylashtiring

`index.html` ni `public/` papkasiga ko'chiring:

```bash
mkdir public
mv index.html public/
```

## 2-qadam: Paketlarni o'rnating

```bash
npm install
```

## 3-qadam: .env faylini sozlang

```bash
cp .env.example .env
```

`.env` faylini oching va to'ldiring:

```env
ANTHROPIC_API_KEY=sk-ant-sizning_kalit_bu_yerga
PORT=3000
NODE_ENV=production
ALLOWED_ORIGINS=https://advokatua.uz,https://www.advokatua.uz
```

## 4-qadam: Serverni ishga tushiring

```bash
# Oddiy ishga tushirish
npm start

# Yoki development rejimda (avtomatik qayta ishga tushadi)
npm run dev
```

Brauzerda oching: http://localhost:3000

---

## Himoya xususiyatlari

| Himoya | Tavsif |
|--------|--------|
| 🔑 API kaliti | `.env` da yashiringan, frontendga chiqmaydi |
| 🛡️ Helmet | 15+ HTTP security header avtomatik |
| 🚫 CORS | Faqat sizning domeningizdan so'rovlar |
| ⏱️ Rate limiting | 100 req/15 min (umumiy), 10 req/5 min (AI) |
| 🧹 Input sanitization | XSS, script injection oldini olish |
| 📦 Request size | Max 20kb so'rov hajmi |
| 📰 News cache | 30 daqiqa — keraksiz API chaqiruvlarni kamaytiradi |
| 🔇 Error leaking | Stack trace foydalanuvchiga ko'rsatilmaydi |

## Production uchun qo'shimcha tavsiyalar

- **HTTPS** — Nginx + Let's Encrypt o'rnating
- **PM2** — `npm install -g pm2 && pm2 start server.js` 
- **Firewall** — faqat 80/443 portlarni oching
- **Nginx** reverse proxy sifatida ishlatish

```nginx
server {
    listen 443 ssl;
    server_name advokatua.uz;
    
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```
