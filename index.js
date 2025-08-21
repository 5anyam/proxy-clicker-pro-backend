import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { nanoid } from 'nanoid';
import { runAutomation } from './automation.js';
import { buildWorkbookBuffer } from './excel.js';

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// In-memory job store (replace with DB later if needed)
const jobs = new Map(); // jobId => { status, urls: [], logs: [], startedAt, finishedAt, proxy: {}, ip: '' }

// Health
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// Start automation with proxy support
app.post('/api/start-automation', async (req, res) => {
  const { url, proxy } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ success: false, error: 'Missing or invalid url' });
  }

  // Validate proxy if provided
  let proxyConfig = null;
  if (proxy && typeof proxy === 'object') {
    if (!proxy.server || typeof proxy.server !== 'string') {
      return res.status(400).json({ 
        success: false, 
        error: 'Invalid proxy config: server is required' 
      });
    }
    proxyConfig = {
      server: proxy.server,
      username: proxy.username || undefined,
      password: proxy.password || undefined
    };
  }

  const jobId = nanoid();
  const job = { 
    status: 'running', 
    urls: [], 
    logs: [], 
    startedAt: new Date().toISOString(),
    proxy: proxyConfig,
    ip: null
  };
  jobs.set(jobId, job);

  // Log proxy configuration
  if (proxyConfig) {
    job.logs.push(`[info] Starting automation with proxy: ${proxyConfig.server}`);
  } else {
    job.logs.push('[info] Starting automation with direct connection');
  }

  // Kick off automation with proxy config
  try {
    const { captured, logs, ip, proxy: usedProxy } = await runAutomation(
      url, 
      msg => job.logs.push(msg), 
      proxyConfig
    );

    job.urls = captured;
    job.logs = logs.length ? logs : job.logs;
    job.status = 'completed';
    job.finishedAt = new Date().toISOString();
    job.ip = ip;
    job.proxy = usedProxy;

    return res.json({ 
      success: true, 
      jobId, 
      status: job.status, 
      count: job.urls.length, 
      urls: job.urls,
      captured: job.urls, // Alternative key for compatibility
      ip: job.ip,
      proxy: job.proxy
    });
  } catch (err) {
    job.status = 'error';
    job.finishedAt = new Date().toISOString();
    const message = err instanceof Error ? err.message : 'Automation failed';
    job.logs.push(`[error] ${message}`);
    return res.status(500).json({ 
      success: false, 
      jobId, 
      error: message,
      proxy: proxyConfig,
      ip: job.ip
    });
  }
});

// Get job status (useful for checking progress)
app.get('/api/job-status/:jobId', (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found' });
  }
  
  return res.json({
    success: true,
    jobId,
    status: job.status,
    count: job.urls.length,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    proxy: job.proxy,
    ip: job.ip,
    logs: job.logs.slice(-10) // Last 10 log entries
  });
});

// Export Excel by jobId (updated with proxy info)
app.get('/api/export-excel', async (req, res) => {
  const { jobId } = req.query;
  if (!jobId || typeof jobId !== 'string') {
    return res.status(400).json({ success: false, error: 'jobId is required' });
  }
  const job = jobs.get(jobId);
  if (!job || job.status !== 'completed') {
    return res.status(404).json({ success: false, error: 'Job not found or not completed' });
  }

  try {
    const buffer = await buildWorkbookBuffer(job.urls, {
      includeProxyInfo: true,
      jobProxy: job.proxy,
      jobIP: job.ip
    });
    const filename = `captured-urls-${jobId}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (error) {
    console.error('Excel export error:', error);
    res.status(500).json({ success: false, error: 'Failed to generate Excel file' });
  }
});

// Export Excel by list of urls (updated with proxy support)
app.post('/api/export-excel', async (req, res) => {
  const { urls } = req.body || {};
  if (!Array.isArray(urls)) {
    return res.status(400).json({ success: false, error: 'urls array is required' });
  }

  const normalized = urls.map(u => {
    if (typeof u === 'string') {
      return { 
        url: u, 
        source: 'unknown', 
        timestamp: new Date().toISOString(),
        ip: null,
        proxy: null
      };
    }
    // Preserve existing proxy and IP info if present
    return {
      url: u.url,
      source: u.source || 'unknown',
      timestamp: u.timestamp || new Date().toISOString(),
      ip: u.ip || null,
      proxy: u.proxy || null
    };
  });

  try {
    const buffer = await buildWorkbookBuffer(normalized, {
      includeProxyInfo: true
    });
    const filename = `captured-urls-${Date.now()}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(buffer);
  } catch (error) {
    console.error('Excel export error:', error);
    res.status(500).json({ success: false, error: 'Failed to generate Excel file' });
  }
});

// Batch automation endpoint (for multiple URLs with individual proxies)
app.post('/api/batch-automation', async (req, res) => {
  const { urls } = req.body || {};
  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ success: false, error: 'urls array is required and must not be empty' });
  }

  const batchJobId = nanoid();
  const batchJob = {
    status: 'running',
    total: urls.length,
    completed: 0,
    failed: 0,
    results: [],
    startedAt: new Date().toISOString()
  };
  jobs.set(batchJobId, batchJob);

  // Process URLs sequentially
  try {
    for (let i = 0; i < urls.length; i++) {
      const item = urls[i];
      const url = typeof item === 'string' ? item : item.url;
      const proxy = (typeof item === 'object' && item.proxy) ? item.proxy : null;

      try {
        const { captured, ip, proxy: usedProxy } = await runAutomation(url, () => {}, proxy);
        batchJob.results.push({
          url,
          status: 'completed',
          captured,
          ip,
          proxy: usedProxy
        });
        batchJob.completed++;
      } catch (error) {
        batchJob.results.push({
          url,
          status: 'failed',
          error: error.message,
          proxy
        });
        batchJob.failed++;
      }
    }

    batchJob.status = 'completed';
    batchJob.finishedAt = new Date().toISOString();

    return res.json({
      success: true,
      batchJobId,
      status: batchJob.status,
      total: batchJob.total,
      completed: batchJob.completed,
      failed: batchJob.failed,
      results: batchJob.results
    });

  } catch (error) {
    batchJob.status = 'error';
    batchJob.finishedAt = new Date().toISOString();
    return res.status(500).json({
      success: false,
      batchJobId,
      error: error.message
    });
  }
});

const PORT = Number(process.env.PORT || 1010);
app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
  console.log('Endpoints available:');
  console.log(`  POST /api/start-automation - Single URL automation (with optional proxy)`);
  console.log(`  POST /api/batch-automation - Multiple URLs automation`);
  console.log(`  GET  /api/job-status/:jobId - Check job status`);
  console.log(`  GET  /api/export-excel?jobId=... - Export by job ID`);
  console.log(`  POST /api/export-excel - Export by URL list`);
  console.log(`  GET  /api/health - Health check`);
});
