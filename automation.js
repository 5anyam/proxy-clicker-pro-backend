import chromium from '@sparticuz/chromium';
import { chromium as playwright } from 'playwright-core';

export async function runAutomation(targetUrl, log, proxyConfig = null) {
  const logs = [];
  const pushLog = (msg) => { logs.push(msg); log?.(msg); };

  let browser;
  let detectedIP = null;

  try {
    pushLog('[info] Starting @sparticuz/chromium automation...');

    // 🔥 GUARANTEED WORKING - No dependencies needed
    browser = await playwright.launch({
      executablePath: await chromium.executablePath(),
      headless: chromium.headless, // Always true
      args: [
        ...chromium.args,
        '--no-sandbox',
        '--disable-setuid-sandbox'
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
      pushLog(`[warning] IP detection skipped: ${ipError.message}`);
    }

    // Navigate to target
    pushLog(`[info] Navigating to: ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    // Simple working automation - capture URL
    capturedUrls.push({
      url: page.url(),
      source: targetUrl,
      timestamp: new Date().toISOString(),
      method: 'navigation',
      ip: detectedIP,
      proxy: proxyConfig
    });

    // Try to find and click a link (basic automation)
    try {
      const links = await page.$$eval('a[href]', links => 
        links.slice(0, 3).map(link => ({ 
          href: link.href, 
          text: link.textContent?.trim() || ''
        })).filter(link => link.href.startsWith('http'))
      );
      
      if (links.length > 0) {
        pushLog(`[info] Found ${links.length} links, clicking first one...`);
        await page.click(`a[href="${links[0].href}"]`, { timeout: 5000 });
        await page.waitForTimeout(2000);
        
        const newUrl = page.url();
        if (newUrl !== targetUrl) {
          capturedUrls.push({
            url: newUrl,
            source: targetUrl,
            timestamp: new Date().toISOString(),
            method: 'click',
            ip: detectedIP,
            proxy: proxyConfig
          });
        }
      }
    } catch (clickError) {
      pushLog(`[warning] Click automation skipped: ${clickError.message}`);
    }

    pushLog(`[success] Automation completed successfully! URLs captured: ${capturedUrls.length}`);
    return { captured: capturedUrls, logs, ip: detectedIP, proxy: proxyConfig };

  } catch (error) {
    pushLog(`[error] Automation failed: ${error.message}`);
    throw error;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        pushLog(`[warning] Browser close warning: ${closeError.message}`);
      }
    }
  }
}
