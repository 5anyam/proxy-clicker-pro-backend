import chromium from '@sparticuz/chromium';
import { chromium as playwright } from 'playwright-core';

export async function runAutomation(targetUrl, log, proxyConfig = null) {
  const logs = [];
  const pushLog = (msg) => { logs.push(msg); log?.(msg); };

  let browser;
  let detectedIP = null;

  try {
    // 🔥 @sparticuz/chromium - No system dependencies needed
    browser = await playwright.launch({
      executablePath: await chromium.executablePath(),
      headless: chromium.headless, // Always true
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
      pushLog(`[info] Using proxy: ${proxyConfig.server}`);
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    let capturedUrls = [];

    // IP Detection
    try {
      const ipResponse = await page.request.get('https://api.ipify.org?format=json', { timeout: 10000 });
      const ipData = await ipResponse.json();
      detectedIP = ipData.ip;
      pushLog(`[info] IP detected: ${detectedIP}`);
    } catch (ipError) {
      pushLog(`[warning] IP detection failed: ${ipError.message}`);
    }

    // Navigate to target
    pushLog(`[info] Navigating to: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Simple automation - capture current URL
    capturedUrls.push({
      url: page.url(),
      source: targetUrl,
      timestamp: new Date().toISOString(),
      method: 'navigation',
      ip: detectedIP,
      proxy: proxyConfig
    });

    pushLog(`[success] Automation completed. URLs: ${capturedUrls.length}`);
    return { captured: capturedUrls, logs, ip: detectedIP, proxy: proxyConfig };

  } catch (error) {
    pushLog(`[error] Automation failed: ${error.message}`);
    throw error;
  } finally {
    if (browser) await browser.close();
  }
}
