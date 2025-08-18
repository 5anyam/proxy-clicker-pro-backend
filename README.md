# Web Automation Backend (Express + Playwright)

This is a standalone Node.js backend providing:
- POST /api/start-automation – runs Playwright automation via ProxyJet US residential proxies
- GET /api/export-excel?jobId=... – returns an Excel of captured URLs for a finished job
- POST /api/export-excel – returns Excel for ad-hoc list of URLs in request body

Quick start

1. Install deps
   npm i

2. Configure ProxyJet credentials
   copy .env.example to .env and fill values.

3. Run locally
   npm run dev

Environment variables

- PROXYJET_API_KEY=            # your ProxyJet API key (username part)
- PROXYJET_PASSWORD=           # your ProxyJet password (password part)
- PROXYJET_COUNTRY=US          # country routing (defaults to US)
- PROXYJET_SERVER=http://proxy-jet.io:1010  # proxy endpoint
- PORT=8080                    # backend port

Deploy
- Deploy this server folder to any Node host (Railway, Render, EC2, VPS). Keep Chromium dependencies in mind for Playwright.
- Frontend should call this server base URL (e.g., https://your-backend.com/api/...)
# proxy-clicker-pro-backend
