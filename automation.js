import { chromium } from 'playwright';

export async function runAutomation(targetUrl, log) {
  const logs = [];
  const pushLog = (msg) => { logs.push(msg); log?.(msg); };

  let browser;
  try {
    browser = await chromium.launch({
      headless: false,
      slowMo: 600,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-popup-blocking'
      ]
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    let capturedUrls = [];

    // Listen for new tabs (outbound links)
    context.on('page', async (newPage) => {
      await newPage.waitForLoadState('load', { timeout: 15000 });
      const newUrl = newPage.url();
      if (newUrl && newUrl !== 'about:blank') {
        capturedUrls.push({
          url: newUrl,
          source: targetUrl,
          timestamp: new Date().toISOString(),
          method: 'new-tab'
        });
        pushLog(`[capture] New tab opened: ${newUrl}`);
      }
      await newPage.close();
    });

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    pushLog(`[info] Page loaded: ${page.url()}`);

    // Scroll & pause to load content
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1500);

    // Find buttons and outbound links in article/main/blog post area
    const candidates = await page.evaluate(() => {
      const results = [];

      // Within main/article/entry-content only
      const mainAreas = Array.from(document.querySelectorAll('main, article, .entry-content, .post-content'));
      for (const area of mainAreas) {
        // Visible and clickable buttons
        area.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]').forEach(el => {
          const style = window.getComputedStyle(el);
          const visible = el.offsetParent !== null && style.display !== 'none' && style.visibility !== 'hidden';
          if (visible) {
            results.push({
              selector: 'button', // generic; Playwright will resolve by index below
              type: 'button',
              text: el.textContent?.trim() || el.value || '',
            });
          }
        });
        // Anchor tags (outbound: target="_blank" or external)
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
                selector: 'a[href]', // generic; will filter by text/href
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
      return { captured: [], logs };
    }
    // Priority: outbound link, otherwise button
    let found = candidates.find(c => c.type === 'link');
    if (!found) found = candidates.find(c => c.type === 'button');
    if (!found) found = candidates[0];

    pushLog(`[info] Will interact with: ${found.type} "${found.text}"`);

    // Strategy for outbound link
    if (found.type === 'link') {
      // Find the link element in Playwright context by text and href
      const allLinks = await page.$$('a[href]');
      let linkHandle = null;
      for (const l of allLinks) {
        const text = (await l.innerText()).trim();
        const href = await l.getAttribute('href');
        if (
          text === found.text ||
          href === found.href
        ) {
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
          method: 'navigation'
        });
        pushLog(`[capture] Navigated to: ${newUrl}`);
      }
    }
    pushLog(`[success] Automation complete. ${capturedUrls.length} URLs ready for XLS.`);

    return { captured: capturedUrls, logs };
  } catch (error) {
    pushLog(`[error] Automation failed: ${error.message}`);
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}
