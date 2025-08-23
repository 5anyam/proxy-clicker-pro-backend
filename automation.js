import { chromium as playwrightChromium } from 'playwright-core';
import chromium from '@sparticuz/chromium';

// Launch helper using playwright-core + @sparticuz/chromium
async function getBrowserContext(proxy) {
  const browser = await playwrightChromium.launch({
    executablePath: await chromium.executablePath(),
    headless: true,
    args: [
      ...chromium.args,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  const contextOptions = proxy?.server
    ? { proxy: { server: proxy.server, username: proxy.username, password: proxy.password } }
    : {};

  const context = await browser.newContext(contextOptions);
  return { browser, context };
}

// Try to close popups/consent quickly
async function tryDismissOverlays(page) {
  try {
    const accept = page.getByRole('button', { name: /accept|agree|ok|continue|got it/i }).first();
    if (await accept.isVisible().catch(() => false)) {
      await accept.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(300);
    }
  } catch {}
}

// Click element and capture resulting URL (new tab or same tab)
async function clickAndCapture(context, page, targetEl, originalUrl) {
  // New tab
  try {
    const [newPage] = await Promise.all([
      context.waitForEvent('page', { timeout: 6000 }),
      targetEl.click({ timeout: 6000 }),
    ]);
    await newPage.waitForLoadState('domcontentloaded', { timeout: 12000 });
    const url = newPage.url();
    await newPage.close().catch(() => {});
    if (url && url !== 'about:blank') return url;
  } catch {}

  // Same tab
  try {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => null),
      targetEl.click({ timeout: 6000 }),
    ]);
    await page.waitForTimeout(1000);
    const url = page.url();
    if (url && url !== originalUrl) return url;
  } catch {}

  return null;
}

export async function runAutomation(targetUrl, log, proxyConfig = null) {
  const logs = [];
  const pushLog = (m) => { logs.push(m); if (typeof log === 'function') log(m); };

  let browser, context;
  let detectedIP = null;
  const captured = [];

  try {
    pushLog('[info] Launching headless Chromium (playwright-core + sparticuz)…');
    ({ browser, context } = await getBrowserContext(proxyConfig));
    const page = await context.newPage();

    // IP detection (via current route/proxy)
    try {
      const ipRes = await page.request.get('https://api.ipify.org?format=json', { timeout: 10000 });
      const ipData = await ipRes.json();
      detectedIP = ipData?.ip || null;
      pushLog(`[info] Detected IP: ${detectedIP}`);
    } catch (e) {
      pushLog(`[warning] IP detection failed: ${e.message}`);
    }

    pushLog(`[info] Opening: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await tryDismissOverlays(page);

    // Small scroll for lazy content
    try { await page.evaluate(() => window.scrollBy(0, 400)); } catch {}
    await page.waitForTimeout(400);

    // Identify main content area (skip header/nav/footer/sidebar)
    const contentSelectors = [
      'main',
      'article',
      '.entry-content',
      '.post-content',
      '.content',
      '.blog-content',
      '[role="main"]',
      '.main-content',
    ];
    let scope = null;
    for (const sel of contentSelectors) {
      try {
        const count = await page.locator(sel).count();
        if (count > 0) {
          scope = page.locator(sel).first();
          pushLog(`[info] Content area detected: ${sel}`);
          break;
        }
      } catch {}
    }
    if (!scope) {
      scope = page.locator('body');
      pushLog('[info] Using <body> as content area (fallback)');
    }

    // Build a prioritized list of clickable CTAs inside content
    const chosen = [];

    // Priority 1: new-tab links (CTAs often open externally)
    try {
      const links = await scope.locator('a[target="_blank"][href]:visible').all();
      for (const el of links) {
        const href = await el.getAttribute('href');
        const text = (await el.innerText().catch(() => '')).trim();
        if (href && !href.startsWith('#')) {
          chosen.push({ el, kind: 'newtab', text, href });
          if (chosen.length >= 3) break;
        }
      }
    } catch {}

    // Priority 2: CTA anchors by common text patterns
    if (chosen.length < 3) {
      const texts = [
        'Read More', 'Continue', 'Continue Reading', 'Learn More',
        'View More', 'Details', 'Explore', 'Get Deal', 'Get Offer',
      ];
      for (const t of texts) {
        try {
          const els = await scope.getByRole('link', { name: new RegExp(t, 'i') }).all();
          for (const el of els) {
            const href = await el.getAttribute('href');
            const text = (await el.innerText().catch(() => '')).trim();
            if (href && !href.startsWith('#')) {
              chosen.push({ el, kind: 'cta-link', text, href });
              if (chosen.length >= 3) break;
            }
          }
        } catch {}
        if (chosen.length >= 3) break;
      }
    }

    // Priority 3: visible buttons inside content
    if (chosen.length < 3) {
      try {
        const btns = await scope.locator('button:visible, [role="button"]:visible, input[type=submit]:visible').all();
        for (const el of btns) {
          const text = (await el.innerText().catch(() => '')).trim()
            || (await el.getAttribute('value').catch(() => '')) || '';
          chosen.push({ el, kind: 'button', text, href: null });
          if (chosen.length >= 3) break;
        }
      } catch {}
    }

    pushLog(`[info] Candidates in content area: ${chosen.length}`);

    // Click at most 3 candidates and capture URL
    const MAX = Math.min(3, chosen.length);
    for (let i = 0; i < MAX; i++) {
      const ch = chosen[i];
      pushLog(`[info] Clicking: "${ch.text || ch.href || ch.kind}" [${ch.kind}]`);
      const newUrl = await clickAndCapture(context, page, ch.el, targetUrl);

      if (newUrl && newUrl !== targetUrl) {
        captured.push({
          url: newUrl,
          source: targetUrl,
          timestamp: new Date().toISOString(),
          method: ch.kind,
          buttonText: ch.text || undefined,
          ip: detectedIP,
          proxy: proxyConfig || null,
        });
        pushLog(`[capture] ${newUrl}`);
      } else {
        pushLog('[info] No navigation detected for this candidate');
      }

      // Reset for next candidate
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await tryDismissOverlays(page);
      await page.waitForTimeout(500);
    }

    // If nothing captured, return original (prevents empty UI)
    if (captured.length === 0) {
      captured.push({
        url: targetUrl,
        source: targetUrl,
        timestamp: new Date().toISOString(),
        method: 'none-found',
        ip: detectedIP,
        proxy: proxyConfig || null,
      });
      pushLog('[info] No URLs captured; returned original page entry');
    }

    pushLog(`[success] Done. Captured ${captured.length} entries`);
    return { captured, logs, ip: detectedIP, proxy: proxyConfig || null };

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    pushLog(`[error] Automation failed: ${msg}`);
    return { captured: [], logs, ip: detectedIP, proxy: proxyConfig || null };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
