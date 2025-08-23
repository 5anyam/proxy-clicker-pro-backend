import { chromium } from 'playwright';

export async function debugScan(targetUrl, proxyConfig = null) {
  const out = { ok: false, url: targetUrl, ip: null, contentSelector: null, buttons: [], error: null };
  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] });
    const context = await browser.newContext(proxyConfig ? { proxy: proxyConfig } : {});
    const page = await context.newPage();
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // IP
    try {
      const ipRes = await page.request.get('https://api.ipify.org?format=json', { timeout: 8000 });
      out.ip = (await ipRes.json()).ip || null;
    } catch {}

    // Content area
    const selectors = ['main','article','.entry-content','.post-content','.content','.blog-content','[role="main"]','.main-content'];
    for (const sel of selectors) {
      const count = await page.locator(sel).count();
      if (count > 0) { out.contentSelector = sel; break; }
    }
    const scope = out.contentSelector ? page.locator(out.contentSelector) : page.locator('body');

    // Collect visible candidates
    const candidates = await scope.locator('a[href]:visible, button:visible, [role="button"]:visible, input[type=submit]:visible').all();
    for (const el of candidates.slice(0, 20)) {
      const text = (await el.textContent() || '').trim();
      const href = await el.getAttribute('href');
      const tag = await el.evaluate(n => n.tagName);
      out.buttons.push({ tag, text, href });
    }
    out.ok = true;
    return out;
  } catch (e) {
    out.error = e.message;
    return out;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
