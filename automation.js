

export async function runAutomation(targetUrl, log, proxyConfig = null) {
  const logs = [];
  const pushLog = (msg) => { logs.push(msg); log?.(msg); };

  try {
    pushLog('[info] Starting HTTP-based automation (No browser needed)...');

    // Simple HTTP request
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const html = await response.text();
    
    // Extract links from HTML
    const linkRegex = /<a[^>]+href\s*=\s*['"]\s*([^'"]+)\s*['"]/gi;
    const matches = [...html.matchAll(linkRegex)];

    capturedUrls.push({
      url: typeof finalUrl === 'string' ? finalUrl : finalUrl.toString(),
      source: typeof targetUrl === 'string' ? targetUrl : targetUrl.toString(),
      timestamp: new Date().toISOString(),
      method: 'navigation',
      ip: detectedIP,
      proxy: proxyConfig
    });
    
    const capturedUrls = matches.slice(0, 5).map(match => ({
      url: match[1].startsWith('http') ? match[21] : `${new URL(targetUrl).origin}${match[21]}`,
      source: targetUrl,
      timestamp: new Date().toISOString(),
      method: 'http-scraping',
      proxy: proxyConfig
    }));

    // Simple IP detection
    let detectedIP = null;
    try {
      const ipResponse = await fetch('https://api.ipify.org?format=json');
      const ipData = await ipResponse.json();
      detectedIP = ipData.ip;
    } catch (ipError) {
      pushLog(`[warning] IP detection failed: ${ipError.message}`);
    }

    pushLog(`[success] HTTP automation completed! ${capturedUrls.length} URLs found`);
    return { captured: capturedUrls, logs, ip: detectedIP, proxy: proxyConfig };

  } catch (error) {
    pushLog(`[error] HTTP automation failed: ${error.message}`);
    throw error;
  }
}