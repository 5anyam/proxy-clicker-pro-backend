import { chromium } from 'playwright';

export async function runAutomation(targetUrl, log, proxyConfig = null) {
  const logs = [];
  const pushLog = (msg) => { logs.push(msg); log?.(msg); };

  // Use provided proxy config or fall back to env variables
  let PROXY_CONFIG = null;
  let usedProxy = null;

  if (proxyConfig && proxyConfig.server) {
    PROXY_CONFIG = {
      server: proxyConfig.server,
      username: proxyConfig.username || undefined,
      password: proxyConfig.password || undefined
    };
    usedProxy = PROXY_CONFIG;
    pushLog(`[info] Using provided proxy: ${PROXY_CONFIG.server}`);
  } else if (process.env.PROXYJET_SERVER) {
    PROXY_CONFIG = {
      server: process.env.PROXYJET_SERVER || 'proxy-jet.io:1010',
      username: process.env.PROXYJET_USERNAME,
      password: process.env.PROXYJET_PASSWORD
    };
    usedProxy = PROXY_CONFIG;
    pushLog(`[info] Using environment proxy: ${PROXY_CONFIG.server}`);
  } else {
    pushLog('[info] No proxy configured, using direct connection');
  }

  let browser;
  let detectedIP = null;

  try {
    browser = await chromium.launch({
      headless: true, // 🔥 HEADLESS MODE - No browser window
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-popup-blocking',
        '--disable-blink-features=AutomationControlled',
        '--enable-webgl',
        '--use-gl=swiftshader',
        '--enable-accelerated-2d-canvas',
        '--disable-dev-shm-usage', // Prevent shared memory issues
        '--disable-gpu', // Disable GPU in headless
        '--no-first-run',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
      ]
    });

    // Context with conditional proxy
    const contextOptions = {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 720 },
      locale: 'en-US',
      timezoneId: 'America/New_York'
    };

    // Add proxy only if configured
    if (PROXY_CONFIG && PROXY_CONFIG.server) {
      contextOptions.proxy = PROXY_CONFIG;
    }

    const context = await browser.newContext(contextOptions);

    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const page = await context.newPage();

    let capturedUrls = [];
    
    if (usedProxy) {
      pushLog(`[info] Headless browser with proxy (${usedProxy.server}), detecting IP...`);
    } else {
      pushLog('[info] Headless browser with direct connection, detecting IP...');
    }

    // IP Detection (works in headless)
    try {
      const ipResponse = await page.request.get('https://api.ipify.org?format=json', { timeout: 15000 });
      const ipData = await ipResponse.json();
      detectedIP = ipData.ip || null;
      pushLog(`[info] IP detected: ${detectedIP}`);
    } catch (ipError) {
      pushLog(`[warning] IP detection failed: ${ipError.message}`);
    }

    // Listen for new tabs
    context.on('page', async (newPage) => {
      await newPage.waitForLoadState('load', { timeout: 15000 });
      const newUrl = newPage.url();
      if (newUrl && newUrl !== 'about:blank') {
        capturedUrls.push({
          url: newUrl,
          source: targetUrl,
          timestamp: new Date().toISOString(),
          method: 'new-tab',
          ip: detectedIP,
          proxy: usedProxy
        });
        pushLog(`[capture] New tab: ${newUrl} (IP: ${detectedIP}, Proxy: ${usedProxy?.server || 'Direct'})`);
      }
      await newPage.close();
    });

    // Navigate to target URL
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    pushLog(`[info] Page loaded: ${page.url()}`);

    // Scroll to bottom (works in headless)
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);

    // Find buttons and outbound links
    const candidates = await page.evaluate(() => {
      const results = [];
      const mainAreas = Array.from(document.querySelectorAll('main, article, .entry-content, .post-content'));
      for (const area of mainAreas) {
        area.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]').forEach(el => {
          const style = window.getComputedStyle(el);
          const visible = el.offsetParent !== null && style.display !== 'none' && style.visibility !== 'hidden';
          if (visible) {
            results.push({
              selector: 'button',
              type: 'button',
              text: el.textContent?.trim() || el.value || '',
            });
          }
        });
        area.querySelectorAll('a[href]').forEach(a => {
          const style = window.getComputedStyle(a);
          const visible = a.offsetParent !== null && style.display !== 'none' && style.visibility !== 'hidden';
          if (visible) {
            const href = a.getAttribute('href') || '';
            if (
              a.target === '_blank' ||
              href.startsWith('http') ||
              href.match(/^\/\/|^mailto:|^tel:/)
            ) {
              results.push({
                selector: 'a[href]',
                type: 'link',
                text: a.textContent?.trim() || href,
                href: href,
                target: a.target
              });
            }
          }
        });
      }
      return results;
    });
    pushLog(`[info] Found ${candidates.length} candidates (headless mode)`);

    if (candidates.length === 0) {
      pushLog('[warning] No clickable elements found');
      return { captured: [], logs, ip: detectedIP, proxy: usedProxy };
    }

    // Find and click elements (works same in headless)
    let found = candidates.find(c => c.type === 'link');
    if (!found) found = candidates.find(c => c.type === 'button');
    if (!found) found = candidates[0];

    pushLog(`[info] Clicking: ${found.type} "${found.text}" (headless)`);

    if (found.type === 'link') {
      const allLinks = await page.$$('a[href]');
      let linkHandle = null;
      for (const l of allLinks) {
        const text = (await l.innerText()).trim();
        const href = await l.getAttribute('href');
        if (text === found.text || href === found.href) {
          linkHandle = l;
          break;
        }
      }
      if (linkHandle) {
        await Promise.all([
          context.waitForEvent('page', { timeout: 15000 }).catch(() => {}),
          linkHandle.click({ force: true }),
        ]);
        await page.waitForTimeout(2500);
      }
    } else {
      const allButtons = await page.$$('button, [role="button"], input[type="button"], input[type="submit"]');
      let btnHandle = null;
      for (const b of allButtons) {
        const text = (await b.innerText()).trim() || (await b.getAttribute('value')) || '';
        if (text === found.text) {
          btnHandle = b;
          break;
        }
      }
      if (btnHandle) {
        await Promise.all([
          context.waitForEvent('page', { timeout: 15000 }).catch(() => {}),
          btnHandle.click({ force: true }),
        ]);
        await page.waitForTimeout(2500);
      }
    }

    // Check for navigation
    if (capturedUrls.length === 0) {
      const newUrl = page.url();
      if (newUrl !== targetUrl && newUrl !== 'about:blank') {
        capturedUrls.push({
          url: newUrl,
          source: targetUrl,
          timestamp: new Date().toISOString(),
          method: 'navigation',
          ip: detectedIP,
          proxy: usedProxy
        });
        pushLog(`[capture] Navigation: ${newUrl} (Headless)`);
      }
    }

    // Ensure all URLs have data
    capturedUrls = capturedUrls.map(urlItem => ({
      ...urlItem,
      ip: urlItem.ip || detectedIP,
      proxy: urlItem.proxy || usedProxy
    }));

    pushLog(`[success] Headless automation complete. ${capturedUrls.length} URLs captured`);
    return { captured: capturedUrls, logs, ip: detectedIP, proxy: usedProxy };

  } catch (error) {
    pushLog(`[error] Headless automation failed: ${error.message}`);
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}
