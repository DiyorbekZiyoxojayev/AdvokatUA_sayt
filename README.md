# AdvokatUA — Premium Huquqiy Sayt

## Ishga tushirish

1. `npm install`
2. `.env.example` ni `.env` ga nusxa oling va API kalitni kiriting
3. `npm start`

## Xavfsizlik
- Helmet.js (CSP, HSTS, XSS himoya)
- Rate limiting (global + AI)
- Input sanitization
- CORS himoya
- Nonce-based CSP

## Arxitektura
```
advokatua/
├── public/index.html   ← Premium frontend
├── server.js           ← Express backend
├── package.json
├── .env.example
└── .gitignore
```
