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

## 1-qadam: Faylni joylashtir
`index.html` ni `public/` papkasiga ko'chir:
```bash
mkdir public
mv index.html public/
```
## 2-qadam: Paketlarni o'rnat
```bash
npm install
```
## 3-qadam: .env faylini sozla
```bash
cp .env.example .env
```
`.env` faylini och va to'ldir:
```env
ANTHROPIC_API_KEY=gsk_RnZFzCdrsMnLIs919YykWGdyb3FY53MRneZ0SkI8W2whx2Ai8Edms
PORT=3000
NODE_ENV=production
ALLOWED_ORIGINS=https://advokatua.uz,https://www.advokatua.uz
```
## 4-qadam: Serverni ishga tushir
```bash
# Oddiy ishga tushirish
npm start
# Yoki development rejimda (avtomatik qayta ishga tushadi)
npm run dev
```
Brauzerda oching: http://localhost:3000
---

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
