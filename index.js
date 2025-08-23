import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { nanoid } from 'nanoid';
import { runAutomation } from './automation.js';
import { buildWorkbookBuffer } from './excel.js';
import { debugScan } from './debugScan.js';


const app = express();

// FIXED CORS Configuration - Allow frontend origins, not backend
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, etc.)
    if (!origin) return callback(null, true);
    
    const allowedOrigins = [
      'https://proxy-clicker-pro.vercel.app/'
      // Add your frontend domain here
    ];
    
    const isAllowed = allowedOrigins.some(pattern => {
      if (typeof pattern === 'string') return origin === pattern;
      return pattern.test(origin);
    });
    
    if (isAllowed || process.env.NODE_ENV === 'development') {
      callback(null, true);
    } else {
      console.log('CORS blocked origin:', origin);
      callback(null, true); // Temporarily allow all for debugging
    }
  },
  credentials: false,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept'],
  preflightContinue: false,
  optionsSuccessStatus: 200
}));

// Additional CORS headers for extra compatibility
app.use((req, res, next) => {
  // Allow all origins temporarily for debugging
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
  
  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    console.log('OPTIONS preflight request from:', req.get('Origin'));
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({ limit: '1mb' }));

// Enhanced request logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path} - Origin: ${req.get('Origin')} - IP: ${req.ip}`);
  next();
});

// In-memory job store (replace with DB later if needed)
const jobs = new Map(); // jobId => { status, urls: [], logs: [], startedAt, finishedAt, proxy: {}, ip: '' }

// Root endpoint - helpful for Railway domain testing
app.get('/', (req, res) => {
  res.json({ 
    message: 'Web Automation Backend API', 
    status: 'running',
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    cors: {
      allowsAllOrigins: true,
      requestOrigin: req.get('Origin')
    },
    endpoints: [
      'GET /api/health',
      'POST /api/start-automation',
      'POST /api/batch-automation',
      'GET /api/job-status/:jobId',
      'GET /api/export-excel?jobId=...',
      'POST /api/export-excel'
    ]
  });
});

app.post('/api/debug-scan', async (req, res) => {
  const { url, proxy } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ ok: false, error: 'Missing or invalid url' });
  }
  try {
    const result = await debugScan(url, proxy || null);
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});


// Health check
app.get('/api/health', (req, res) => {
  console.log('Health check request from origin:', req.get('Origin'));
  res.json({ 
    ok: true, 
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    memory: process.memoryUsage(),
    cors: {
      requestOrigin: req.get('Origin'),
      userAgent: req.get('User-Agent')
    }
  });
});

// Start automation with proxy support
app.post('/api/start-automation', async (req, res) => {
  console.log('POST /api/start-automation - Request received');
  console.log('Request Origin:', req.get('Origin'));
  console.log('Request Headers:', req.headers);
  console.log('Request body:', JSON.stringify(req.body, null, 2));

  const { url, proxy } = req.body || {};
  if (!url || typeof url !== 'string') {
    console.log('Error: Missing or invalid URL');
    return res.status(400).json({ success: false, error: 'Missing or invalid url' });
  }

  // Validate proxy if provided
  let proxyConfig = null;
  if (proxy && typeof proxy === 'object') {
    if (!proxy.server || typeof proxy.server !== 'string') {
      console.log('Error: Invalid proxy config');
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
    console.log('Proxy config validated:', { server: proxyConfig.server });
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

  console.log(`Job ${jobId} created for URL: ${url}`);

  // Log proxy configuration
  if (proxyConfig) {
    job.logs.push(`[info] Starting automation with proxy: ${proxyConfig.server}`);
  } else {
    job.logs.push('[info] Starting automation with direct connection');
  }

  // Kick off automation with proxy config
  try {
    console.log(`Starting automation for job ${jobId}`);
    const { captured, logs, ip, proxy: usedProxy } = await runAutomation(
      url, 
      msg => {
        console.log(`Job ${jobId}: ${msg}`);
        job.logs.push(msg);
      }, 
      proxyConfig
    );

    job.urls = captured || [];
    job.logs = logs && logs.length ? logs : job.logs;
    job.status = 'completed';
    job.finishedAt = new Date().toISOString();
    job.ip = ip;
    job.proxy = usedProxy;

    console.log(`Job ${jobId} completed successfully. Captured ${job.urls.length} URLs`);

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
    console.error(`Job ${jobId} failed:`, err);
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
  console.log(`GET /api/job-status/${jobId}`);
  
  const job = jobs.get(jobId);
  if (!job) {
    console.log(`Job ${jobId} not found`);
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
  console.log(`GET /api/export-excel?jobId=${jobId}`);
  
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
    console.log(`Excel exported for job ${jobId}`);
  } catch (error) {
    console.error('Excel export error:', error);
    res.status(500).json({ success: false, error: 'Failed to generate Excel file' });
  }
});

// Export Excel by list of urls (updated with proxy support)
app.post('/api/export-excel', async (req, res) => {
  console.log('POST /api/export-excel');
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
    console.log(`Excel exported for ${urls.length} URLs`);
  } catch (error) {
    console.error('Excel export error:', error);
    res.status(500).json({ success: false, error: 'Failed to generate Excel file' });
  }
});

// Batch automation endpoint (for multiple URLs with individual proxies)
app.post('/api/batch-automation', async (req, res) => {
  console.log('POST /api/batch-automation');
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
  console.log(`Batch job ${batchJobId} created for ${urls.length} URLs`);

  // Process URLs sequentially
  try {
    for (let i = 0; i < urls.length; i++) {
      const item = urls[i];
      const url = typeof item === 'string' ? item : item.url;
      const proxy = (typeof item === 'object' && item.proxy) ? item.proxy : null;

      console.log(`Processing batch item ${i + 1}/${urls.length}: ${url}`);

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
        console.error(`Batch item ${i + 1} failed:`, error.message);
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
    console.log(`Batch job ${batchJobId} completed: ${batchJob.completed} success, ${batchJob.failed} failed`);

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
    console.error(`Batch job ${batchJobId} error:`, error);
    batchJob.status = 'error';
    batchJob.finishedAt = new Date().toISOString();
    return res.status(500).json({
      success: false,
      batchJobId,
      error: error.message
    });
  }
});

// CORS test endpoint
app.get('/api/cors-test', (req, res) => {
  res.json({
    message: 'CORS is working!',
    origin: req.get('Origin'),
    timestamp: new Date().toISOString()
  });
});

// Catch-all handler for API routes (404 handler)
app.all('/api/*', (req, res) => {
  console.log(`404: API route not found - ${req.method} ${req.path} from origin: ${req.get('Origin')}`);
  res.status(404).json({ 
    success: false, 
    error: `API route not found: ${req.method} ${req.path}`,
    availableRoutes: [
      'GET /api/health',
      'GET /api/cors-test',
      'POST /api/start-automation',
      'POST /api/batch-automation',
      'GET /api/job-status/:jobId',
      'GET /api/export-excel?jobId=...',
      'POST /api/export-excel'
    ]
  });
});

// General 404 handler for all other routes
app.use((req, res) => {
  console.log(`404: Route not found - ${req.method} ${req.path}`);
  res.status(404).json({ 
    error: 'Route not found',
    message: 'This is a Web Automation API. Visit /api/health for status.',
    path: req.path,
    method: req.method
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Global error handler:', err);
  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: err.message
  });
});

const PORT = Number(process.env.PORT || 1010);
app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(50));
  console.log(`🚀 Backend listening on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`⏰ Started at: ${new Date().toISOString()}`);
  console.log('🔒 CORS: Allowing all origins for debugging');
  console.log('📋 Endpoints available:');
  console.log(`  GET  / - API Information`);
  console.log(`  GET  /api/health - Health check`);
  console.log(`  GET  /api/cors-test - CORS test endpoint`);
  console.log(`  POST /api/start-automation - Single URL automation (with optional proxy)`);
  console.log(`  POST /api/batch-automation - Multiple URLs automation`);
  console.log(`  GET  /api/job-status/:jobId - Check job status`);
  console.log(`  GET  /api/export-excel?jobId=... - Export by job ID`);
  console.log(`  POST /api/export-excel - Export by URL list`);
  console.log('='.repeat(50));
});
