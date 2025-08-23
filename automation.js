import { chromium } from 'playwright';

// Helper: click target and capture resulting URL (new tab or navigation)
async function clickAndCapture(context, page, targetEl, originalUrl) {
  // Try: new tab
  try {
    const [newPage] = await Promise.all([
      context.waitForEvent('page', { timeout: 6000 }),
      targetEl.click({ timeout: 6000 })
    ]);
    await newPage.waitForLoadState('domcontentloaded', { timeout: 12000 });
    const url = newPage.url();
    await newPage.close().catch(() => {});
    if (url && url !== 'about:blank') return url;
  } catch {}

  // Fallback: same tab navigation
  try {
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 12000 }).catch(() => null),
      targetEl.click({ timeout: 6000 })
    ]);
    await page.waitForTimeout(1200);
    const url = page.url();
    if (url && url !== originalUrl) return url;
  } catch {}

  return null;
}

// Helper: best-effort to accept consent popups
async function tryDismissOverlays(page) {
  try {
    const accept = page.getByRole('button', { name: /accept|agree|ok/i }).first();
    if (await accept.isVisible().catch(() => false)) {
      await accept.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(400);
    }
  } catch {}
}

export async function runAutomation(targetUrl, log, proxyConfig = null) {
  const logs = [];
  const pushLog = (msg) => { logs.push(msg); if (typeof log === 'function') log(msg); };

  let browser;
  let detectedIP = null;
  let captured = [];

  try {
    pushLog('[info] Launching Playwright...');
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const contextOptions = {};
    if (proxyConfig && proxyConfig.server) {
      contextOptions.proxy = {
        server: proxyConfig.server,
        username: proxyConfig.username || undefined,
        password: proxyConfig.password || undefined
      };
      pushLog(`[info] Using proxy: ${proxyConfig.server}`);
    }
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    // Detect IP with current route (proxy/direct)
    try {
      const ipResponse = await page.request.get('https://api.ipify.org?format=json', { timeout: 10000 });
      const ipData = await ipResponse.json();
      detectedIP = ipData?.ip || null;
      pushLog(`[info] Detected IP: ${detectedIP}`);
    } catch (e) {
      pushLog(`[warning] IP detection failed: ${e.message}`);
    }

    pushLog(`[info] Opening: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await tryDismissOverlays(page);

    // Small scroll to reveal lazy content
    await page.evaluate(() => window.scrollBy(0, 400)).catch(() => {});
    await page.waitForTimeout(500);

    // Pick main content area (ignore navbar/footer/sidebar)
    const contentSelectors = [
      'main',
      'article',
      '.entry-content',
      '.post-content',
      '.content',
      '.blog-content',
      '[role="main"]',
      '.main-content'
    ];
    let scope = null;
    for (const sel of contentSelectors) {
      const count = await page.locator(sel).count().catch(() => 0);
      if (count > 0) {
        scope = page.locator(sel).first();
        pushLog(`[info] Content area: ${sel}`);
        break;
      }
    }
    if (!scope) {
      scope = page.locator('body');
      pushLog('[info] Using <body> as content area (fallback)');
    }

    // Collect candidate CTAs inside content area
    const chosen = [];

    // Priority 1: links opening new tab
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

    // Priority 2: CTA anchors by text
    if (chosen.length < 3) {
      const texts = ['Read More', 'Continue', 'Continue Reading', 'Learn More', 'View More', 'Details', 'Explore', 'Get Deal', 'Get Offer'];
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

    // Priority 3: visible button-like controls in content
    if (chosen.length < 3) {
      try {
        const btns = await scope.locator('button:visible, [role="button"]:visible, input[type=submit]:visible').all();
        for (const el of btns) {
          const text = (await el.innerText().catch(() => '')).trim() ||
                       (await el.getAttribute('value').catch(() => '')) || '';
          chosen.push({ el, kind: 'button', text, href: null });
          if (chosen.length >= 3) break;
        }
      } catch {}
    }

    pushLog(`[info] Clickable candidates in content area: ${chosen.length}`);

    // Click top 3 candidates deterministically
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
          proxy: proxyConfig || null
        });
        pushLog(`[capture] Captured URL: ${newUrl}`);
      } else {
        pushLog('[info] No navigation detected, retrying next candidate');
      }

      // Return to original for next click
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await tryDismissOverlays(page);
      await page.waitForTimeout(600);
    }

    // If nothing captured, still return original
    if (captured.length === 0) {
      captured.push({
        url: targetUrl,
        source: targetUrl,
        timestamp: new Date().toISOString(),
        method: 'none-found',
        ip: detectedIP,
        proxy: proxyConfig || null
      });
      pushLog('[info] No URLs captured via clicks; returning original page entry');
    }

    pushLog(`[success] Completed. Captured ${captured.length} entries`);
    return { captured, logs, ip: detectedIP, proxy: proxyConfig || null };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    pushLog(`[error] Automation failed: ${msg}`);
    return { captured: [], logs, ip: detectedIP, proxy: proxyConfig || null };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
