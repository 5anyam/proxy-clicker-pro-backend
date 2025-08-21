import { chromium } from 'playwright';
// If using Node.js: import dotenv from 'dotenv'; dotenv.config();

export async function runAutomation(targetUrl, log, proxyConfig = null) {
  const logs = [];
  const pushLog = (msg) => { logs.push(msg); log?.(msg); };

  // Use provided proxy config or fall back to env variables
  let PROXY_CONFIG = null;
  let usedProxy = null;

  if (proxyConfig && proxyConfig.server) {
    // Use proxy from request parameter (from Excel or single input)
    PROXY_CONFIG = {
      server: proxyConfig.server,
      username: proxyConfig.username || undefined,
      password: proxyConfig.password || undefined
    };
    usedProxy = PROXY_CONFIG;
    pushLog(`[info] Using provided proxy: ${PROXY_CONFIG.server}`);
  } else if (process.env.PROXYJET_SERVER) {
    // Fall back to environment variables
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
  let detectedIP = null; // Store detected IP address

  try {
    browser = await chromium.launch({
      headless: false,
      slowMo: 600,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-popup-blocking',
        '--disable-blink-features=AutomationControlled', // hides automation detection
        '--enable-webgl', // GPU features (look real)
        '--use-gl=swiftshader',
        '--enable-accelerated-2d-canvas'
      ]
    });

    // Stealth context config with conditional proxy
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

    // Patch navigator.webdriver to false for ALL pages in context
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });

    const page = await context.newPage();

    // Random human-like mouse move and scroll
    await page.mouse.move(
      Math.floor(100 + Math.random() * 400),
      Math.floor(100 + Math.random() * 300)
    );
    await page.waitForTimeout(Math.floor(800 + Math.random() * 1200));

    let capturedUrls = [];
    
    if (usedProxy) {
      pushLog(`[info] Proxy configured (${usedProxy.server}), detecting IP...`);
    } else {
      pushLog('[info] Direct connection, detecting IP...');
    }

    // DETECT IP ADDRESS FIRST - Multiple fallbacks for reliability
    try {
      // Method 1: Try api.ipify.org (most reliable)
      try {
        const ipResponse = await page.request.get('https://api.ipify.org?format=json', { timeout: 15000 });
        const ipData = await ipResponse.json();
        detectedIP = ipData.ip || null;
        pushLog(`[info] IP detected via ipify: ${detectedIP}`);
      } catch (ipError1) {
        pushLog(`[warning] ipify.org failed: ${ipError1.message}`);
        
        // Method 2: Try httpbin.org
        try {
          const ipResponse2 = await page.goto('https://httpbin.org/ip', { timeout: 15000 });
          const ipText = await page.textContent('body');
          const ipData2 = JSON.parse(ipText);
          detectedIP = ipData2.origin ? ipData2.origin.split(',')[0].trim() : null;
          pushLog(`[info] IP detected via httpbin: ${detectedIP}`);
        } catch (ipError2) {
          pushLog(`[warning] httpbin.org failed: ${ipError2.message}`);
          
          // Method 3: Try ipinfo.io as final fallback
          try {
            const ipResponse3 = await page.request.get('https://ipinfo.io/json', { timeout: 15000 });
            const ipData3 = await ipResponse3.json();
            detectedIP = ipData3.ip || null;
            pushLog(`[info] IP detected via ipinfo: ${detectedIP}`);
          } catch (ipError3) {
            pushLog(`[warning] All IP detection methods failed. Continuing without IP.`);
          }
        }
      }
    } catch (generalIpError) {
      pushLog(`[warning] IP detection failed: ${generalIpError.message}`);
    }

    // Listen for new tabs (outbound links)
    context.on('page', async (newPage) => {
      await newPage.waitForLoadState('load', { timeout: 15000 });
      const newUrl = newPage.url();
      if (newUrl && newUrl !== 'about:blank') {
        capturedUrls.push({
          url: newUrl,
          source: targetUrl,
          timestamp: new Date().toISOString(),
          method: 'new-tab',
          ip: detectedIP, // Include IP address
          proxy: usedProxy // Include proxy information
        });
        pushLog(`[capture] New tab opened: ${newUrl} (IP: ${detectedIP}, Proxy: ${usedProxy?.server || 'Direct'})`);
      }
      await newPage.close();
    });

    // NOW NAVIGATE TO TARGET URL
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    pushLog(`[info] Page loaded: ${page.url()}`);

    // Scroll to bottom to help lazy-load content
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);

    // Find buttons and outbound links in article/main/blog post area
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
    pushLog(`[info] Found ${candidates.length} button/outbound link candidates`);

    if (candidates.length === 0) {
      pushLog('[warning] No clickable elements found in main content area');
      return { 
        captured: [], 
        logs, 
        ip: detectedIP, 
        proxy: usedProxy 
      }; // Include IP and proxy even if no URLs captured
    }

    // Priority: outbound link, otherwise button
    let found = candidates.find(c => c.type === 'link');
    if (!found) found = candidates.find(c => c.type === 'button');
    if (!found) found = candidates[0];

    pushLog(`[info] Will interact with: ${found.type} "${found.text}"`);

    // Strategy for outbound link
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
        pushLog('[click] Clicking outbound link');
        await Promise.all([
          context.waitForEvent('page', { timeout: 15000 }).catch(() => {}),
          linkHandle.click({ force: true }),
        ]);
        await page.waitForTimeout(2500);
      }
    } else {
      // Strategy for button
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
        pushLog('[click] Clicking button');
        await Promise.all([
          context.waitForEvent('page', { timeout: 15000 }).catch(() => {}),
          btnHandle.click({ force: true }),
        ]);
        await page.waitForTimeout(2500);
      }
    }

    // If no new tab, check for navigation
    if (capturedUrls.length === 0) {
      const newUrl = page.url();
      if (newUrl !== targetUrl && newUrl !== 'about:blank') {
        capturedUrls.push({
          url: newUrl,
          source: targetUrl,
          timestamp: new Date().toISOString(),
          method: 'navigation',
          ip: detectedIP, // Include IP address
          proxy: usedProxy // Include proxy information
        });
        pushLog(`[capture] Navigated to: ${newUrl} (IP: ${detectedIP}, Proxy: ${usedProxy?.server || 'Direct'})`);
      }
    }

    // Ensure all captured URLs have IP address and proxy info included
    capturedUrls = capturedUrls.map(urlItem => ({
      ...urlItem,
      ip: urlItem.ip || detectedIP, // Ensure IP is included in all items
      proxy: urlItem.proxy || usedProxy // Ensure proxy info is included
    }));

    pushLog(`[success] Automation complete. ${capturedUrls.length} URLs ready for XLS. IP: ${detectedIP}, Proxy: ${usedProxy?.server || 'Direct'}`);
    return { 
      captured: capturedUrls, 
      logs, 
      ip: detectedIP, 
      proxy: usedProxy 
    }; // Include IP and proxy in main response

  } catch (error) {
    pushLog(`[error] Automation failed: ${error.message}`);
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}
