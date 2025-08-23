export async function runAutomation(targetUrl, log, proxyConfig = null) {
  const logs = [];
  const pushLog = (msg) => { 
    logs.push(msg); 
    if (log) log(msg); 
  };

  // ✅ Declare all variables at the top (fixes initialization error)
  let capturedUrls = [];
  let detectedIP = null;

  try {
    pushLog('[info] Starting HTTP-based automation (No browser needed)...');

    // Simple HTTP request
    const response = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });

    const html = await response.text();
    
    // Extract links from HTML using regex
    const linkRegex = /<a[^>]+href\s*=\s*['"]\s*([^'"]+)\s*['"]/gi;
    let match;
    const extractedLinks = [];
    
    // Extract up to 10 links
    while ((match = linkRegex.exec(html)) !== null && extractedLinks.length < 10) {
      extractedLinks.push(match[1]);
    }
    
    // Convert to proper URL objects (fixes [object Object] issue)
    capturedUrls = extractedLinks.map(href => {
      let absoluteUrl;
      try {
        // Handle relative and absolute URLs properly
        if (href.startsWith('http')) {
          absoluteUrl = href;
        } else {
          absoluteUrl = new URL(href, targetUrl).toString();
        }
      } catch (error) {
        // Fallback for invalid URLs
        absoluteUrl = href;
      }
      
      return {
        url: absoluteUrl, // ✅ Always a string
        source: targetUrl,
        timestamp: new Date().toISOString(),
        method: 'http-scraping',
        proxy: proxyConfig
      };
    });

    // Simple IP detection
    try {
      const ipResponse = await fetch('https://api.ipify.org?format=json');
      const ipData = await ipResponse.json();
      detectedIP = ipData.ip;
      pushLog(`[info] IP detected: ${detectedIP}`);
    } catch (ipError) {
      pushLog(`[warning] IP detection failed: ${ipError.message}`);
    }

    // Add IP to all captured URLs
    capturedUrls = capturedUrls.map(item => ({
      ...item,
      ip: detectedIP
    }));

    pushLog(`[success] HTTP automation completed! ${capturedUrls.length} URLs found`);
    
    // ✅ Always return consistent structure
    return { 
      captured: capturedUrls, 
      logs, 
      ip: detectedIP, 
      proxy: proxyConfig 
    };

  } catch (error) {
    pushLog(`[error] HTTP automation failed: ${error.message}`);
    
    // ✅ Return safe empty result (don't throw)
    return { 
      captured: [], 
      logs, 
      ip: detectedIP, 
      proxy: proxyConfig 
    };
  }
}
