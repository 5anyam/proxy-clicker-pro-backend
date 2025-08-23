export async function runAutomation(targetUrl, log, proxyConfig = null) {
  const logs = [];
  const pushLog = (msg) => { logs.push(msg); if (log) log(msg); };

  // Declare variables at start
  let capturedUrls = [];
  let detectedIP = null;
  let browser;

  try {
    pushLog('[info] Starting smart blog automation with button clicking...');

    // Use Playwright with proxy for button clicking automation
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    });

    const contextOptions = {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      viewport: { width: 1280, height: 720 }
    };

    // Add proxy if provided
    if (proxyConfig && proxyConfig.server) {
      contextOptions.proxy = proxyConfig;
      pushLog(`[info] Using proxy: ${proxyConfig.server}`);
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    // IP Detection with proxy
    try {
      const ipResponse = await page.request.get('https://api.ipify.org?format=json', { timeout: 10000 });
      const ipData = await ipResponse.json();
      detectedIP = ipData.ip;
      pushLog(`[info] IP detected: ${detectedIP}`);
    } catch (ipError) {
      pushLog(`[warning] IP detection failed: ${ipError.message}`);
    }

    // Navigate to target page
    pushLog(`[info] Navigating to: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for page to load completely
    await page.waitForTimeout(2000);

    // 🎯 Smart Content Area Detection (Skip navbar, footer, sidebar)
    const contentSelectors = [
      'main', 
      'article', 
      '.content', 
      '.post-content', 
      '.entry-content',
      '.blog-content',
      '.article-body',
      '[role="main"]',
      '.main-content'
    ];

    let mainContentArea;
    for (const selector of contentSelectors) {
      try {
        mainContentArea = await page.locator(selector).first();
        if (await mainContentArea.count() > 0) {
          pushLog(`[info] Found main content area: ${selector}`);
          break;
        }
      } catch (e) {
        continue;
      }
    }

    // Fallback to body if no main content found
    if (!mainContentArea || await mainContentArea.count() === 0) {
      mainContentArea = page.locator('body');
      pushLog('[info] Using body as content area (fallback)');
    }

    // 🎯 Smart Button Detection in Content Area Only
    const buttonSelectors = [
      'button:visible',
      'a[href]:has-text("Read More"):visible',
      'a[href]:has-text("Continue Reading"):visible',
      'a[href]:has-text("Learn More"):visible',
      'a[href]:has-text("View More"):visible',
      'a[href]:has-text("Click Here"):visible',
      'input[type="button"]:visible',
      'input[type="submit"]:visible',
      '[role="button"]:visible',
      '.btn:visible',
      '.button:visible'
    ];

    let foundButtons = [];
    for (const selector of buttonSelectors) {
      try {
        const buttons = await mainContentArea.locator(selector).all();
        for (const btn of buttons) {
          const isVisible = await btn.isVisible();
          if (isVisible) {
            const text = await btn.textContent() || '';
            const href = await btn.getAttribute('href') || '';
            foundButtons.push({ element: btn, text: text.trim(), href, selector });
          }
        }
      } catch (e) {
        // Skip if selector fails
        continue;
      }
    }

    pushLog(`[info] Found ${foundButtons.length} clickable buttons in content area`);

    if (foundButtons.length === 0) {
      // Fallback: Try to find ANY clickable elements
      try {
        const fallbackButtons = await mainContentArea.locator('a[href]:visible').all();
        for (let i = 0; i < Math.min(3, fallbackButtons.length); i++) {
          const btn = fallbackButtons[i];
          const text = await btn.textContent() || '';
          const href = await btn.getAttribute('href') || '';
          foundButtons.push({ element: btn, text: text.trim(), href, selector: 'a[href]' });
        }
        pushLog(`[info] Using fallback links: ${foundButtons.length} found`);
      } catch (e) {
        pushLog('[warning] No clickable elements found');
      }
    }

    // 🎯 Click Buttons and Capture URLs
    for (let i = 0; i < Math.min(3, foundButtons.length); i++) {
      const button = foundButtons[i];
      
      try {
        pushLog(`[info] Clicking button ${i + 1}: "${button.text}" (${button.selector})`);

        // Check if button opens in new tab or navigates
        let newUrl = null;

        // Try to catch new page/tab opening
        const [newPage] = await Promise.race([
          Promise.all([
            context.waitForEvent('page', { timeout: 5000 }),
            button.element.click({ timeout: 5000 })
          ]),
          // Fallback: Just click and check current page navigation
          (async () => {
            await button.element.click({ timeout: 5000 });
            await page.waitForTimeout(2000);
            return [null];
          })()
        ]);

        if (newPage) {
          // New tab/window opened
          await newPage.waitForLoadState('load', { timeout: 10000 });
          newUrl = newPage.url();
          pushLog(`[capture] New tab opened: ${newUrl}`);
          await newPage.close();
        } else {
          // Check if current page navigated
          const currentUrl = page.url();
          if (currentUrl !== targetUrl) {
            newUrl = currentUrl;
            pushLog(`[capture] Page navigated: ${newUrl}`);
            // Navigate back for next button
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
            await page.waitForTimeout(1000);
          }
        }

        // Capture the URL
        if (newUrl && newUrl !== targetUrl) {
          capturedUrls.push({
            url: newUrl,
            source: targetUrl,
            timestamp: new Date().toISOString(),
            method: 'button-click',
            buttonText: button.text,
            ip: detectedIP,
            proxy: proxyConfig
          });
        }

      } catch (clickError) {
        pushLog(`[warning] Failed to click button ${i + 1}: ${clickError.message}`);
        continue;
      }
    }

    // Add original URL if no buttons found
    if (capturedUrls.length === 0) {
      capturedUrls.push({
        url: targetUrl,
        source: targetUrl,
        timestamp: new Date().toISOString(),
        method: 'original-page',
        ip: detectedIP,
        proxy: proxyConfig
      });
      pushLog('[info] No new URLs captured, returning original page');
    }

    pushLog(`[success] Automation completed! Captured ${capturedUrls.length} URLs from button clicks`);

    return {
      captured: capturedUrls,
      logs,
      ip: detectedIP,
      proxy: proxyConfig
    };

  } catch (error) {
    pushLog(`[error] Automation failed: ${error.message}`);
    return { captured: [], logs, ip: detectedIP, proxy: proxyConfig };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        // Ignore close errors
      }
    }
  }
}
