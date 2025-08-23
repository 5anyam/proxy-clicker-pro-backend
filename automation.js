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
  let captured = []; // Initialize as empty array

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
    push('[info] Page loaded successfully');

    // Wait a bit for dynamic content
    await page.waitForTimeout(2000);

    // **SIMPLE STRATEGY: Just get ALL visible links on the page**
    const allLinks = await page.locator('a[href]:visible').all();
    push(`[info] Found ${allLinks.length} total links on page`);

    const validUrls = [];
    
    // Process first 10 links
    for (let i = 0; i < Math.min(10, allLinks.length); i++) {
      try {
        const link = allLinks[i];
        const href = await link.getAttribute('href');
        const text = (await link.textContent() || '').trim();
        
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) {
          continue;
        }
        
        // Make absolute URL
        let fullUrl;
        try {
          if (href.startsWith('http')) {
            fullUrl = href;
          } else {
            fullUrl = new URL(href, targetUrl).toString();
          }
        } catch {
          continue;
        }
        
        // Skip same domain exact matches
        if (fullUrl === targetUrl) {
          continue;
        }
        
        validUrls.push({
          url: fullUrl,
          text: text || href,
          index: i + 1
        });
        
        push(`[found] Link ${i+1}: ${fullUrl}`);
        
        if (validUrls.length >= 5) break; // Limit to 5
        
      } catch (linkErr) {
        push(`[warn] Error processing link ${i+1}: ${linkErr.message}`);
      }
    }

    push(`[info] Valid URLs found: ${validUrls.length}`);

    // **Convert to captured format**
    for (const urlData of validUrls) {
      captured.push({
        url: urlData.url,
        source: targetUrl,
        timestamp: new Date().toISOString(),
        method: 'link-extraction',
        buttonText: urlData.text,
        ip: ip,
        proxy: proxyConfig || null
      });
    }

    // **GUARANTEED: Always return at least original URL if nothing found**
    if (captured.length === 0) {
      captured.push({
        url: targetUrl,
        source: targetUrl,
        timestamp: new Date().toISOString(),
        method: 'original-fallback',
        ip: ip,
        proxy: proxyConfig || null
      });
      push('[info] No links found, returning original URL');
    }

    push(`[success] Completed. Captured ${captured.length} URLs`);
    
    // **IMPORTANT: Return in exact format expected by frontend**
    return { 
      captured: captured,  // This is the key field
      logs: logs, 
      ip: ip, 
      proxy: proxyConfig || null 
    };

  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    push(`[error] ${msg}`);
    
    // **Even on error, return original URL so UI shows something**
    return { 
      captured: [{
        url: targetUrl,
        source: targetUrl,
        timestamp: new Date().toISOString(),
        method: 'error-fallback',
        ip: ip,
        proxy: proxyConfig || null
      }],
      logs: logs, 
      ip: ip, 
      proxy: proxyConfig || null 
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}
