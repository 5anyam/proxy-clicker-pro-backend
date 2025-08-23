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
  let captured = [];

  try {
    push('[info] Starting button click automation...');
    ({ browser, context } = await getBrowserContext(proxyConfig));
    const page = await context.newPage();

    // IP detection with proxy
    try {
      const ipRes = await page.request.get('https://api.ipify.org?format=json', { timeout: 15000 });
      ip = (await ipRes.json())?.ip || null;
      push(`[info] IP detected: ${ip}`);
    } catch (e) {
      push(`[warn] IP detection failed: ${e.message}`);
      // Try direct HTTP method
      try {
        const response = await fetch('https://api.ipify.org?format=json');
        const data = await response.json();
        ip = data?.ip || null;
        push(`[info] IP via fetch: ${ip}`);
      } catch {}
    }

    push(`[info] Opening: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Remove popups/overlays that might block buttons
    try {
      const overlays = [
        'button:has-text("Accept")', 'button:has-text("OK")', 'button:has-text("Agree")',
        '[class*="cookie"]', '[class*="consent"]', '[id*="popup"]', '[class*="modal"]'
      ];
      for (const sel of overlays) {
        const el = page.locator(sel).first();
        if (await el.isVisible().catch(() => false)) {
          await el.click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(500);
          push(`[info] Closed overlay: ${sel}`);
          break;
        }
      }
    } catch {}

    await page.waitForTimeout(2000); // Let page stabilize

    // Find main content area (avoid header/nav/footer buttons)
    let contentArea = null;
    const contentSelectors = ['main', 'article', '.entry-content', '.post-content', '.content', '.blog-content'];
    
    for (const sel of contentSelectors) {
      try {
        const count = await page.locator(sel).count();
        if (count > 0) {
          contentArea = page.locator(sel).first();
          push(`[info] Content area: ${sel}`);
          break;
        }
      } catch {}
    }
    
    if (!contentArea) {
      contentArea = page.locator('body');
      push('[info] Using body as content area');
    }

    // STRATEGY 1: Find CTA buttons in content area
    const buttonCandidates = [];
    
    // Look for common CTA text patterns
    const ctaTexts = ['Read More', 'Continue', 'Learn More', 'View More', 'Get Deal', 'Shop Now', 'Buy Now', 'Try Now', 'See More', 'Details'];
    
    for (const text of ctaTexts) {
      try {
        const btns = await contentArea.getByRole('button', { name: new RegExp(text, 'i') }).all();
        for (const btn of btns) {
          if (await btn.isVisible().catch(() => false)) {
            buttonCandidates.push({ element: btn, text: text, type: 'button-text' });
            if (buttonCandidates.length >= 3) break;
          }
        }
        if (buttonCandidates.length >= 3) break;
      } catch {}
    }

    // Look for buttons with common CSS classes
    if (buttonCandidates.length < 3) {
      const buttonSelectors = ['button.btn', 'button.button', '[role="button"]', 'input[type="submit"]'];
      for (const sel of buttonSelectors) {
        try {
          const btns = await contentArea.locator(sel + ':visible').all();
          for (const btn of btns) {
            const text = (await btn.textContent().catch(() => '')) || 'Button';
            buttonCandidates.push({ element: btn, text: text.trim(), type: 'button-class' });
            if (buttonCandidates.length >= 3) break;
          }
          if (buttonCandidates.length >= 3) break;
        } catch {}
      }
    }

    // STRATEGY 2: Find CTA links in content area
    const linkCandidates = [];
    
    for (const text of ctaTexts) {
      try {
        const links = await contentArea.getByRole('link', { name: new RegExp(text, 'i') }).all();
        for (const link of links) {
          const href = await link.getAttribute('href');
          if (href && !href.startsWith('#')) {
            const fullUrl = href.startsWith('http') ? href : new URL(href, targetUrl).toString();
            linkCandidates.push({ element: link, url: fullUrl, text: text, type: 'cta-link' });
            if (linkCandidates.length >= 3) break;
          }
        }
        if (linkCandidates.length >= 3) break;
      } catch {}
    }

    push(`[info] Found ${buttonCandidates.length} buttons, ${linkCandidates.length} CTA links`);

    // TRY CLICKING BUTTONS AND CAPTURE NEW PAGES
    const allCandidates = [...buttonCandidates, ...linkCandidates];
    
    for (let i = 0; i < Math.min(3, allCandidates.length); i++) {
      const candidate = allCandidates[i];
      push(`[info] Clicking ${candidate.type}: "${candidate.text}"`);

      try {
        // Set up new page listener BEFORE clicking
        const newPagePromise = context.waitForEvent('page', { timeout: 8000 });
        
        // Click the element
        await candidate.element.click({ timeout: 5000 });
        
        try {
          // Wait for new page to open
          const newPage = await newPagePromise;
          await newPage.waitForLoadState('domcontentloaded', { timeout: 10000 });
          
          const newUrl = newPage.url();
          await newPage.close();
          
          if (newUrl && newUrl !== 'about:blank' && newUrl !== targetUrl) {
            captured.push({
              url: newUrl,
              source: targetUrl,
              timestamp: new Date().toISOString(),
              method: 'button-click-newtab',
              buttonText: candidate.text,
              ip: ip,
              proxy: proxyConfig || null
            });
            push(`[capture] New tab: ${newUrl}`);
          }
        } catch (newPageErr) {
          // Check if current page navigated
          await page.waitForTimeout(1000);
          const currentUrl = page.url();
          if (currentUrl !== targetUrl) {
            captured.push({
              url: currentUrl,
              source: targetUrl,
              timestamp: new Date().toISOString(),
              method: 'button-click-navigation',
              buttonText: candidate.text,
              ip: ip,
              proxy: proxyConfig || null
            });
            push(`[capture] Same tab navigation: ${currentUrl}`);
            // Go back for next button
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
          } else if (candidate.url) {
            // Fallback: use link href directly
            captured.push({
              url: candidate.url,
              source: targetUrl,
              timestamp: new Date().toISOString(),
              method: 'href-direct',
              buttonText: candidate.text,
              ip: ip,
              proxy: proxyConfig || null
            });
            push(`[capture] Direct href: ${candidate.url}`);
          }
        }
      } catch (clickErr) {
        push(`[warn] Click failed: ${clickErr.message}`);
      }
    }

    // FALLBACK: If no buttons worked, get top external links
    if (captured.length === 0) {
      try {
        const allLinks = await contentArea.locator('a[href]:visible').all();
        for (let i = 0; i < Math.min(5, allLinks.length); i++) {
          const link = allLinks[i];
          const href = await link.getAttribute('href');
          const text = (await link.textContent()).trim();
          
          if (href && !href.startsWith('#')) {
            const fullUrl = href.startsWith('http') ? href : new URL(href, targetUrl).toString();
            if (fullUrl !== targetUrl) {
              captured.push({
                url: fullUrl,
                source: targetUrl,
                timestamp: new Date().toISOString(),
                method: 'content-link-fallback',
                buttonText: text || href,
                ip: ip,
                proxy: proxyConfig || null
              });
            }
          }
        }
        push(`[fallback] Found ${captured.length} content links`);
      } catch {}
    }

    // GUARANTEED: Always return at least original URL
    if (captured.length === 0) {
      captured.push({
        url: targetUrl,
        source: targetUrl,
        timestamp: new Date().toISOString(),
        method: 'original-page',
        ip: ip,
        proxy: proxyConfig || null
      });
      push('[info] No new URLs found, returned original');
    }

    push(`[success] Completed. Captured ${captured.length} URLs with IP: ${ip}`);
    return { captured, logs, ip, proxy: proxyConfig || null };

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    push(`[error] ${msg}`);
    return { 
      captured: [{
        url: targetUrl, source: targetUrl, timestamp: new Date().toISOString(),
        method: 'error-fallback', ip: ip, proxy: proxyConfig || null
      }],
      logs, ip, proxy: proxyConfig || null 
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
