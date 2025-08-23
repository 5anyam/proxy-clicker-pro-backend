// Updated automation.js - Headless + Lightweight
import chromium from '@sparticuz/chromium';
import { chromium as playwright } from 'playwright-core';

export async function runAutomation(targetUrl, log, proxyConfig = null) {
  const logs = [];
  const pushLog = (msg) => { logs.push(msg); log?.(msg); };

  let browser;
  let detectedIP = null;

  try {
    // 🔥 Headless + Lightweight approach
    browser = await playwright.launch({
      executablePath: await chromium.executablePath(), // Bundled chromium
      headless: true, // NO BROWSER WINDOW
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage'
      ]
    });

    const contextOptions = {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      viewport: { width: 1280, height: 720 }
    };

    if (proxyConfig?.server) {
      contextOptions.proxy = proxyConfig;
      pushLog(`[info] Headless automation with proxy: ${proxyConfig.server}`);
    } else {
      pushLog('[info] Headless automation without proxy');
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    let capturedUrls = [];

    // IP Detection (works perfectly in headless)
    try {
      const ipResponse = await page.request.get('https://api.ipify.org?format=json');
      const ipData = await ipResponse.json();
      detectedIP = ipData.ip;
      pushLog(`[info] IP detected (headless): ${detectedIP}`);
    } catch (ipError) {
      pushLog(`[warning] IP detection failed: ${ipError.message}`);
    }

    // Navigate and automate (all works in headless)
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    pushLog(`[info] Page loaded in headless mode`);

    // Simple automation - capture current URL
    capturedUrls.push({
      url: page.url(),
      source: targetUrl,
      timestamp: new Date().toISOString(),
      method: 'headless-navigation',
      ip: detectedIP,
      proxy: proxyConfig
    });

    pushLog(`[success] Headless automation completed. ${capturedUrls.length} URLs captured`);
    return { captured: capturedUrls, logs, ip: detectedIP, proxy: proxyConfig };

  } catch (error) {
    pushLog(`[error] Headless automation failed: ${error.message}`);
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}
