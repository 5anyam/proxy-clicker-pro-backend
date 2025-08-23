import { chromium } from 'playwright';

const buildProxyAuth = () => {
  const apiKey = process.env.PROXYJET_API_KEY;
  const password = process.env.PROXYJET_PASSWORD;
  const server = process.env.PROXYJET_SERVER || 'http://proxy-jet.io:1010';
  if (!apiKey || !password) {
    throw new Error('Missing ProxyJet credentials. Please set PROXYJET_API_KEY and PROXYJET_PASSWORD');
  }
  const country = (process.env.PROXYJET_COUNTRY || 'US').toUpperCase();
  // Use US residential by default
  const username = `${apiKey}-resi_country-${country}`;
  return { server, username, password };
};

async function autoScroll(page) {
  await page.evaluate(async () => {
    const delay = (ms) => new Promise(r => setTimeout(r, ms));
    const totalHeight = document.body.scrollHeight;
    let current = 0;
    const step = Math.floor(window.innerHeight * 0.6);
    while (current < totalHeight) {
      window.scrollBy(0, step);
      current += step;
      await delay(400 + Math.random() * 400);
    }
    window.scrollTo(0, document.body.scrollHeight);
    await delay(800);
  });
}

function absolutizeUrl(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

export async function runAutomation(targetUrl, log) {
  const logs = [];
  const pushLog = (m) => { logs.push(m); log?.(m); };

  const proxy = buildProxyAuth();
  pushLog(`[info] Launching Chromium with ProxyJet (${proxy.server})`);

  const browser = await chromium.launch({ headless: true, proxy });
  const context = await browser.newContext();
  const page = await context.newPage();

  const captured = new Set();
  const captureUrl = (u, source = 'navigation') => {
    if (!u) return;
    try {
      const parsed = new URL(u);
      const clean = parsed.toString();
      if (!captured.has(clean)) captured.add(clean);
    } catch {}
  };

  // Listen for new pages (target=_blank)
  context.on('page', async (newPage) => {
    try {
      await newPage.waitForLoadState('load', { timeout: 10000 }).catch(() => {});
      captureUrl(newPage.url(), 'new-page');
      await newPage.close().catch(() => {});
    } catch {}
  });

  // Capture redirects/navigation on main page
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      captureUrl(frame.url(), 'navigate');
    }
  });

  try {
    pushLog('[info] Opening page…');
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    captureUrl(page.url(), 'initial');

    pushLog('[info] Scrolling…');
    await autoScroll(page);

    pushLog('[info] Detecting links…');
    const anchors = await page.$$eval('a[href]', (as) => as
      .filter(a => a.getAttribute('href'))
      .map(a => ({
        href: a.getAttribute('href'),
        text: (a.textContent || '').trim().slice(0, 80),
        target: a.getAttribute('target') || ''
      }))
    );

    // Buttons that might trigger navigation (best-effort)
    const buttons = await page.$$eval('button', (bs) => bs
      .filter(b => !b.disabled)
      .map((b, i) => ({ index: i, text: (b.textContent || '').trim().slice(0, 80) }))
    );

    const clickableSummary = { anchors: anchors.length, buttons: buttons.length };
    pushLog(`[info] Found ${clickableSummary.anchors} links and ${clickableSummary.buttons} buttons`);

    pushLog('[info] Clicking links…');
    // Click a limited number to avoid extremely long runs
    const MAX_CLICKS = Math.min(anchors.length, 40);

    for (let i = 0; i < MAX_CLICKS; i++) {
      const a = anchors[i];
      const absolute = absolutizeUrl(a.href, page.url());
      if (!absolute) continue;

      // Scroll into view and click by selector built from href
      try {
        await page.evaluate((href) => {
          const el = Array.from(document.querySelectorAll('a[href]')).find(a => a.getAttribute('href') === href);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }, a.href);

        const [nav] = await Promise.all([
          page.waitForNavigation({ timeout: 8000 }).catch(() => null),
          page.click(`a[href="${CSS.escape(a.href)}"]`, { timeout: 5000 }).catch(() => null)
        ]);

        if (nav) {
          captureUrl(page.url(), 'click');
          // Go back to the original page to continue
          await page.goBack({ timeout: 10000 }).catch(() => {});
        }
      } catch {}
    }

    // As a fallback, collect all discovered hrefs without clicking
    anchors.forEach(a => {
      const absolute = absolutizeUrl(a.href, page.url());
      if (absolute) captureUrl(absolute, 'detected');
    });

    pushLog('[info] Done');

    const result = { captured: Array.from(captured), logs };
    await browser.close();
    return result;
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}
