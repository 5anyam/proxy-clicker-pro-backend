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

    // Hide obvious non-content areas to avoid navbar/footer picks
    await page.addStyleTag({
      content: `
        header, nav, footer, aside, .site-header, .site-footer, .sidebar,
        .sticky, .cookie, .consent, .newsletter, .ads,
        [role="banner"], [role="navigation"], [role="contentinfo"] {
          display: none !important;
          visibility: hidden !important;
        }
      `
    }).catch(() => {});

    // Small scroll for lazy content
    try { await page.evaluate(() => window.scrollTo(0, 0)); } catch {}
    await page.waitForTimeout(300);

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

    // Helper to collect candidates by selector list
    async function collectBySelectors(selectors, label, max = 6) {
      const results = [];
      for (const sel of selectors) {
        try {
          const nodes = await scope.locator(sel).all();
          for (const el of nodes) {
            const visible = await el.isVisible().catch(() => false);
            if (!visible) continue;
            const text = ((await el.innerText().catch(() => '')) || '').trim();
            const href = await el.getAttribute('href').catch(() => null);
            results.push({ el, kind: label, text, href, sel });
            if (results.length >= max) break;
          }
        } catch {}
        if (results.length >= max) break;
      }
      return results;
    }

    // 1) Highest priority: explicit CTAs inside content
    const ctaTexts = [
      'Read More', 'Continue', 'Continue Reading', 'Learn More', 'View More',
      'Explore', 'Get Deal', 'Get Offer', 'Shop Now', 'Buy Now', 'See More',
      'Details', 'Try Now', 'Start', 'Sign Up', 'Join'
    ];

    const candidates = [];

    // A. role=link by text
    for (const t of ctaTexts) {
      try {
        const els = await scope.getByRole('link', { name: new RegExp(`\\b${t}\\b`, 'i') }).all();
        for (const el of els) {
          const href = await el.getAttribute('href').catch(() => null);
          const text = ((await el.innerText().catch(() => '')) || '').trim();
          candidates.push({ el, kind: 'link-text', text, href, sel: `role=link name~"${t}"` });
          if (candidates.length >= 6) break;
        }
      } catch {}
      if (candidates.length >= 6) break;
    }

    // B. role=button by text
    if (candidates.length < 6) {
      for (const t of ctaTexts) {
        try {
          const els = await scope.getByRole('button', { name: new RegExp(`\\b${t}\\b`, 'i') }).all();
          for (const el of els) {
            const text = ((await el.innerText().catch(() => '')) || '').trim();
            candidates.push({ el, kind: 'button-text', text, href: null, sel: `role=button name~"${t}"` });
            if (candidates.length >= 6) break;
          }
        } catch {}
        if (candidates.length >= 6) break;
      }
    }

    // C. common CTA classes/data-attrs
    if (candidates.length < 6) {
      const classSelectors = [
        'a.btn[href]', 'a.button[href]', 'a.cta[href]', 'a.read-more[href]',
        'button.btn', 'button.button', '[data-cta]', '[data-test*="cta"]'
      ];
      const cands = await collectBySelectors(classSelectors, 'cta-class', 6 - candidates.length);
      candidates.push(...cands);
    }

    // D. new-tab anchors in content (often outbound CTAs)
    if (candidates.length < 6) {
      const cands = await collectBySelectors(['a[target="_blank"][href]:visible'], 'newtab', 6 - candidates.length);
      candidates.push(...cands);
    }

    // E. any external link in content as last fallback
    if (candidates.length < 6) {
      try {
        const links = await scope.locator('a[href]:visible').all();
        for (const el of links) {
          const href = await el.getAttribute('href').catch(() => null);
          if (!href || href.startsWith('#')) continue;
          const abs = href.startsWith('http') ? href : new URL(href, targetUrl).toString();
          const text = ((await el.innerText().catch(() => '')) || '').trim();
          candidates.push({ el, kind: 'external-fallback', text, href: abs, sel: 'a[href]' });
          if (candidates.length >= 6) break;
        }
      } catch {}
    }

    pushLog(`[info] Total candidate CTAs found: ${candidates.length}`);

    // SPA-aware URL change watcher wrapper
    async function clickAndWatch(ch) {
      const beforeUrl = page.url();

      const navUrl = await clickAndCapture(context, page, ch.el, targetUrl);
      if (navUrl) return navUrl;

      try {
        await page.waitForFunction(
          (u) => location.href !== u, beforeUrl,
          { timeout: 4000 }
        ).catch(() => {});
      } catch {}

      const afterUrl = page.url();
      if (afterUrl && afterUrl !== beforeUrl) return afterUrl;

      await page.waitForTimeout(1000);
      const finalUrl = page.url();
      if (finalUrl && finalUrl !== beforeUrl) return finalUrl;

      return null;
    }

    // Try first 3 candidates
    const limit = Math.min(3, candidates.length);
    for (let i = 0; i < limit; i++) {
      const ch = candidates[i];
      pushLog(`[info] Clicking candidate ${i + 1}/${limit}: kind=${ch.kind} sel=${ch.sel} text="${ch.text}"`);
      const newUrl = await clickAndWatch(ch);

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
        pushLog(`[capture] ${newUrl}`);
      } else {
        pushLog(`[info] No navigation captured for candidate ${i + 1}`);
      }

      // Reset to original for next attempt
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await tryDismissOverlays(page);
      await page.waitForTimeout(400);
    }

    // If still nothing, return original once so UI isn’t empty
    if (captured.length === 0) {
      captured.push({
        url: targetUrl,
        source: targetUrl,
        timestamp: new Date().toISOString(),
        method: 'none-found',
        ip: detectedIP,
        proxy: proxyConfig || null
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
