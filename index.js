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
const jobs = new Map(); // jobId => { status, urls: [], logs: [], startedAt, finishedAt }

// Health
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// Start automation
app.post('/api/start-automation', async (req, res) => {
  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ success: false, error: 'Missing or invalid url' });
  }

  const jobId = nanoid();
  const job = { status: 'running', urls: [], logs: [], startedAt: new Date().toISOString() };
  jobs.set(jobId, job);

  // Kick off automation (blocking for simplicity). For long pages, consider queue/background.
  try {
    const { captured, logs } = await runAutomation(url, msg => job.logs.push(msg));
    job.urls = captured;
    job.logs = logs.length ? logs : job.logs;
    job.status = 'completed';
    job.finishedAt = new Date().toISOString();
    return res.json({ success: true, jobId, status: job.status, count: job.urls.length, urls: job.urls });
  } catch (err) {
    job.status = 'error';
    job.finishedAt = new Date().toISOString();
    const message = err instanceof Error ? err.message : 'Automation failed';
    job.logs.push(`[error] ${message}`);
    return res.status(500).json({ success: false, jobId, error: message });
  }
});

// Export Excel by jobId
app.get('/api/export-excel', async (req, res) => {
  const { jobId } = req.query;
  if (!jobId || typeof jobId !== 'string') {
    return res.status(400).json({ success: false, error: 'jobId is required' });
  }
  const job = jobs.get(jobId);
  if (!job || job.status !== 'completed') {
    return res.status(404).json({ success: false, error: 'Job not found or not completed' });
  }

  const buffer = await buildWorkbookBuffer(job.urls);
  const filename = `captured-urls-${jobId}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
});

// Export Excel by list of urls
app.post('/api/export-excel', async (req, res) => {
  const { urls } = req.body || {};
  if (!Array.isArray(urls)) {
    return res.status(400).json({ success: false, error: 'urls array is required' });
  }
  const normalized = urls.map(u => {
    if (typeof u === 'string') return { url: u, source: 'unknown', timestamp: new Date().toISOString() };
    return u;
  });
  const buffer = await buildWorkbookBuffer(normalized);
  const filename = `captured-urls-${Date.now()}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buffer);
});

const PORT = Number(process.env.PORT || 8081);
app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});
