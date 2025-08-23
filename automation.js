import { chromium as playwrightChromium } from 'playwright-core';
import chromium from '@sparticuz/chromium';

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

export async function runAutomation(targetUrl, log, proxyConfig = null) {
  const logs = [];
  const push = (m) => { logs.push(m); if (typeof log === 'function') log(m); };

  let browser, context;
  let ip = null;
  const captured = [];

  try {
    push('[info] Starting automation...');
    ({ browser, context } = await getBrowserContext(proxyConfig));
    const page = await context.newPage();

    // IP detection
    try {
      const ipRes = await page.request.get('https://api.ipify.org?format=json', { timeout: 8000 });
      ip = (await ipRes.json())?.ip || null;
      push(`[info] IP: ${ip}`);
    } catch (e) {
      push(`[warn] IP failed: ${e.message}`);
    }

    push(`[info] Opening: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Remove popups/overlays
    try {
      const overlay = page.locator('button:has-text("Accept"), button:has-text("OK"), button:has-text("Agree"), [class*="cookie"], [class*="consent"]').first();
      if (await overlay.isVisible().catch(() => false)) {
        await overlay.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(500);
      }
    } catch {}

    // Find main content area (skip header/nav/footer)
    let contentArea = null;
    const contentSelectors = ['main', 'article', '.entry-content', '.post-content', '.content', '.blog-content'];
    
    for (const sel of contentSelectors) {
      try {
        const count = await page.locator(sel).count();
        if (count > 0) {
          contentArea = page.locator(sel).first();
          push(`[info] Content found: ${sel}`);
          break;
        }
      } catch {}
    }
    
    if (!contentArea) {
      contentArea = page.locator('body');
      push('[info] Using body as fallback');
    }

    // **STRATEGY 1: Find ALL links in content and try top 5**
    const allLinks = await contentArea.locator('a[href]:visible').all();
    const linkCandidates = [];
    
    for (const link of allLinks) {
      try {
        const href = await link.getAttribute('href');
        const text = (await link.innerText().catch(() => '')).trim();
        
        if (!href || href.startsWith('#')) continue;
        
        // Make absolute URL
        let fullUrl;
        if (href.startsWith('http')) {
          fullUrl = href;
        } else {
          try {
            fullUrl = new URL(href, targetUrl).toString();
          } catch {
            continue;
          }
        }
        
        linkCandidates.push({ 
          element: link, 
          url: fullUrl, 
          text: text || href,
          method: 'content-link'
        });
        
        if (linkCandidates.length >= 10) break;
      } catch {}
    }

    push(`[info] Found ${linkCandidates.length} link candidates`);

    // **STRATEGY 2: Try clicking first 3 links and capture their target URLs**
    for (let i = 0; i < Math.min(3, linkCandidates.length); i++) {
      const candidate = linkCandidates[i];
      push(`[info] Trying link ${i+1}: "${candidate.text}"`);

      try {
        // Check if link opens in new tab
        const target = await candidate.element.getAttribute('target');
        
        if (target === '_blank') {
          // New tab case
          try {
            const [newPage] = await Promise.all([
              context.waitForEvent('page', { timeout: 5000 }),
              candidate.element.click({ timeout: 5000 })
            ]);
            await newPage.waitForLoadState('domcontentloaded', { timeout: 10000 });
            const newUrl = newPage.url();
            await newPage.close();
            
            captured.push({
              url: newUrl,
              source: targetUrl,
              timestamp: new Date().toISOString(),
              method: 'new-tab-click',
              buttonText: candidate.text,
              ip,
              proxy: proxyConfig || null
            });
            push(`[capture] New tab: ${newUrl}`);
          } catch (clickErr) {
            push(`[warn] New tab click failed: ${clickErr.message}`);
          }
        } else {
          // **DIRECT URL APPROACH: If click fails, just use the href**
          captured.push({
            url: candidate.url,
            source: targetUrl,
            timestamp: new Date().toISOString(),
            method: 'href-direct',
            buttonText: candidate.text,
            ip,
            proxy: proxyConfig || null
          });
          push(`[capture] Direct href: ${candidate.url}`);
        }
      } catch (err) {
        push(`[warn] Link ${i+1} failed: ${err.message}`);
      }
    }

    // **STRATEGY 3: If no links, find buttons and external forms**
    if (captured.length === 0) {
      const buttons = await contentArea.locator('button:visible, [role="button"]:visible, input[type="submit"]:visible').all();
      push(`[info] Found ${buttons.length} buttons as fallback`);
      
      for (let i = 0; i < Math.min(2, buttons.length); i++) {
        try {
          const btn = buttons[i];
          const text = (await btn.innerText().catch(() => '')).trim() || 
                       (await btn.getAttribute('value').catch(() => '')) || 
                       `Button ${i+1}`;
          
          push(`[info] Trying button: "${text}"`);
          
          // Try clicking button and wait for navigation
          try {
            await Promise.all([
              page.waitForNavigation({ timeout: 8000 }).catch(() => null),
              btn.click({ timeout: 5000 })
            ]);
            
            await page.waitForTimeout(1000);
            const newUrl = page.url();
            
            if (newUrl !== targetUrl) {
              captured.push({
                url: newUrl,
                source: targetUrl,
                timestamp: new Date().toISOString(),
                method: 'button-click',
                buttonText: text,
                ip,
                proxy: proxyConfig || null
              });
              push(`[capture] Button nav: ${newUrl}`);
              break;
            }
          } catch (btnErr) {
            push(`[warn] Button click failed: ${btnErr.message}`);
          }
        } catch {}
      }
    }

    // **FALLBACK: Return original page if nothing captured**
    if (captured.length === 0) {
      captured.push({
        url: targetUrl,
        source: targetUrl,
        timestamp: new Date().toISOString(),
        method: 'original-page',
        ip,
        proxy: proxyConfig || null
      });
      push('[info] No new URLs found, returned original page');
    }

    push(`[success] Completed. Captured ${captured.length} URLs`);
    return { captured, logs, ip, proxy: proxyConfig || null };

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    push(`[error] ${msg}`);
    return { captured: [], logs, ip, proxy: proxyConfig || null };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
