// attendance.js (ESM)
// IMPORTANT: Load environment variables FIRST, before any modules that depend on them
import dotenv from 'dotenv';
import path from 'path';

// Load .env from project root (where .env file is located)
dotenv.config({
  path: path.resolve(process.cwd(), '.env')
});

import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import jwt from 'jsonwebtoken';
import fetch from 'node-fetch';
import { CookieJar } from 'tough-cookie';
import fetchCookie from 'fetch-cookie';
import * as cheerio from 'cheerio';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import { body, validationResult } from 'express-validator';
import logger from './lib/logger.js';
import authRouter from './routes/auth.js';
import adminRouter from './routes/admin.js';
import bcrypt from 'bcryptjs';
import { scrapeDatewiseAttendance } from './src/services/datewiseAttendanceService.js';
import { getSharedPool, closePool as closeDbPool } from './src/sharedDb.js';
import { cleanup as cleanupBrowserPool } from './src/services/browserPool.js';

const app = express();

// Security headers
app.use(helmet());

app.use(bodyParser.json());

// Rate limiting - skip for localhost in development
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: process.env.NODE_ENV === 'development' ? 1000 : 100, // Much higher limit in dev
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: 'Too many requests from this IP, please try again later.',
  // Skip rate limiting for localhost in development
  skip: (req) => {
    if (process.env.NODE_ENV === 'development') {
      const ip = req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress || ''
      const isLocalhost = ip === '127.0.0.1' || 
                          ip === '::1' || 
                          ip === '::ffff:127.0.0.1' || 
                          ip.startsWith('127.0.0.1') || 
                          ip.startsWith('::1') ||
                          ip === 'localhost' ||
                          !ip || ip === 'undefined'
      if (isLocalhost) {
        return true // Skip rate limiting for localhost in dev
      }
    }
    return false
  }
});

// --- CORS + Request Logging ---
// IMPORTANT: CORS must be applied BEFORE routes to handle OPTIONS preflight requests
const allowedOrigins = process.env.FRONTEND_URL 
  ? process.env.FRONTEND_URL.split(',').map(url => url.trim())
  : [
      'http://localhost:5173',
      'http://localhost:5174',
      'http://localhost:3000',
      'http://localhost:3001'
    ];

// Log allowed origins for debugging
logger.info('CORS configuration', {
  hasFrontendUrl: !!process.env.FRONTEND_URL,
  allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : 'none (localhost only)',
  nodeEnv: process.env.NODE_ENV || 'development'
});

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) {
      logger.debug('[CORS] Allowing request with no origin');
      return callback(null, true);
    }
    
    // Allow any localhost port for development
    if (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
      logger.debug('[CORS] Allowing localhost origin:', origin);
      return callback(null, true);
    }
    
    if (allowedOrigins.indexOf(origin) !== -1) {
      logger.debug('[CORS] Allowing origin:', origin);
      callback(null, true);
    } else {
      logger.warn('[CORS] Rejected origin:', origin, 'Allowed origins:', allowedOrigins);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: false,
  preflightContinue: false,
  optionsSuccessStatus: 204
}));

app.use('/api/', apiLimiter);
// Mount auth router for student_id-based login
app.use('/api/auth', authRouter);
app.use('/api/admin', adminRouter);

// Log every incoming request for debugging (without leaking sensitive payloads)
app.use((req, res, next) => {
  const start = Date.now();
  const { method, originalUrl } = req;
  res.on('finish', () => {
    const durationMs = Date.now() - start;
    logger.info(`[req] ${method} ${originalUrl}`, {
      status: res.statusCode,
      durationMs,
      ip: req.ip,
    });
  });
  next();
});
// --- End CORS + Logging ---

// Enforce SECRET in production
if (process.env.NODE_ENV === 'production' && !process.env.SECRET) {
  logger.error('FATAL: SECRET env var is required in production');
  process.exit(1);
}

// Use JWT_SECRET if set, otherwise SECRET, otherwise dev fallback
const SECRET = process.env.JWT_SECRET || process.env.SECRET || 'dev-secret-for-local';
logger.info('JWT secret configured', { 
  hasJwtSecret: !!process.env.JWT_SECRET,
  hasSecret: !!process.env.SECRET,
  secretLength: SECRET.length,
  usingFallback: !process.env.JWT_SECRET && !process.env.SECRET
});
const PORT = process.env.PORT || 3000;
const DB_URL = process.env.DATABASE_URL || '';
const SCRAPER_URL = process.env.SCRAPER_URL || '';
if (DB_URL) {
  // Log connection info (without password)
  const dbInfo = DB_URL.replace(/:\/\/[^:]+:[^@]+@/, '://***:***@');
  logger.info('Database URL configured', { url: dbInfo });
} else {
  logger.warn('DATABASE_URL not set in environment');
}
if (SCRAPER_URL) {
  logger.info('Scraper URL configured', { url: SCRAPER_URL });
} else {
  logger.warn('SCRAPER_URL not set - scraper verification disabled');
}

// --- Simple in-memory rate limiter & scrape trackers ---
const lastLoginAt = {}; // username -> timestamp ms
const scrapingStatus = {}; // username -> { running: boolean, promise: Promise }

// ---- Database Connection ----
// Use shared pool to prevent multiple pool instances
const pool = getSharedPool();

// --- Helpers ---
function signToken(payload, expiresIn = '15m') {
  return jwt.sign(payload, SECRET, { expiresIn });
}

function verifyToken(token) {
  try {
    const decoded = jwt.verify(token, SECRET);
    logger.debug('JWT verification succeeded', { 
      userId: decoded.userId,
      studentId: decoded.student_id,
      tokenLength: token?.length
    });
    return decoded;
  } catch (err) {
    logger.debug('JWT verification failed', { 
      message: err.message,
      name: err.name,
      tokenLength: token?.length,
      secretLength: SECRET?.length,
      secretSet: !!SECRET,
      secretPrefix: SECRET?.substring(0, 10) + '...',
      tokenPrefix: token?.substring(0, 20) + '...'
    });
    return null;
  }
}

// ---------- DB helpers and schema ----------
async function ensureSchema() {
  try {
    if (!DB_URL) {
      logger.warn('DATABASE_URL not set - skipping schema initialization');
      return;
    }
    // Test connection first
    await pool.query('SELECT 1');
    await pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    
    // Create users table with login_count
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        student_id text UNIQUE NOT NULL,
        password_hash text NOT NULL,
        name text,
        login_count integer DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_login_at timestamptz,
        scraper_checked_at timestamptz,
        scraper_exists boolean DEFAULT NULL
      );
    `);
    
    // Create index on student_id
    await pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_student_id ON users (student_id)`);
    
    // Add login_count column if table already exists
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS login_count integer DEFAULT 0`).catch(e => logger.warn('Column login_count may already exist:', e.message));
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at timestamptz`).catch(e => logger.warn('Column last_login_at may already exist:', e.message));
    
    // Attendance storage tables
    await pool.query(`
      CREATE TABLE IF NOT EXISTS attendance (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        username text NOT NULL,
        student_name text,
        subject text,
        present integer,
        absent integer,
        total integer,
        percent numeric,
        margin integer,
        required integer,
        recorded_at timestamptz DEFAULT now(),
        source text
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_attendance_username ON attendance(username)`).catch(e => logger.warn('Index may already exist:', e.message));
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_attendance_recorded_at ON attendance(recorded_at DESC)`).catch(e => logger.warn('Index may already exist:', e.message));
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS upcoming_classes (
        id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
        username text NOT NULL,
        class_id text,
        class_name text,
        start_time timestamptz,
        end_time timestamptz,
        metadata jsonb,
        fetched_at timestamptz DEFAULT now()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_upcoming_classes_username ON upcoming_classes(username)`).catch(e => logger.warn('Index may already exist:', e.message));
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_upcoming_classes_start_time ON upcoming_classes(start_time)`).catch(e => logger.warn('Index may already exist:', e.message));
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS latest_snapshot (
        username text PRIMARY KEY,
        attendance_id uuid REFERENCES attendance(id) ON DELETE SET NULL,
        fetched_at timestamptz DEFAULT now()
      );
    `);
    await pool.query(`CREATE INDEX IF NOT EXISTS idx_latest_snapshot_attendance_id ON latest_snapshot(attendance_id)`).catch(e => logger.warn('Index may already exist:', e.message));
    
    logger.info('DB schema ensured');
  } catch (err) {
    logger.error('DB ensure schema error', { error: err.message });
  }
}

async function getUserByStudentId(student_id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE student_id = $1', [student_id]);
  return rows[0] || null;
}

async function getUserById(id) {
  const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] || null;
}

// Simple auth middleware - just verify token, no subscription checks
async function requireAuth(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    logger.debug('[requireAuth] Received auth header', { 
      hasHeader: !!auth,
      headerLength: auth.length,
      startsWithBearer: auth.startsWith('Bearer '),
      headerPrefix: auth.substring(0, 30) + '...'
    });
    
    if (!auth.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'unauthorized', message: 'Missing Authorization header' });
    }
    const token = auth.slice(7).trim(); // Trim whitespace
    if (!token) {
      return res.status(401).json({ error: 'unauthorized', message: 'Empty token' });
    }
    
    logger.debug('[requireAuth] Extracted token', { 
      tokenLength: token.length,
      tokenPrefix: token.substring(0, 30) + '...',
      tokenSuffix: '...' + token.substring(token.length - 10)
    });
    
    const payload = verifyToken(token);
    if (!payload || !payload.userId) {
      logger.debug('[requireAuth] Token verification failed', { 
        tokenLength: token.length,
        tokenPrefix: token.substring(0, 20) + '...',
        hasUserId: payload?.userId ? true : false,
        payloadKeys: payload ? Object.keys(payload) : null
      });
      return res.status(401).json({ error: 'unauthorized', message: 'Invalid token' });
    }
    
    logger.debug('[requireAuth] Token verified successfully', { 
      userId: payload.userId,
      studentId: payload.student_id
    });
    
    // Verify user exists in database
    const user = await getUserById(payload.userId);
    if (!user) {
      logger.debug('[requireAuth] User not found in database', { userId: payload.userId });
      return res.status(401).json({ error: 'unauthorized', message: 'User not found' });
    }
    
    req.user = user;
    next();
  } catch (err) {
    logger.error('[requireAuth] Error in auth middleware', {
      error: err.message,
      stack: err.stack,
      url: req.url,
      method: req.method
    });
    return res.status(500).json({ error: 'Internal server error', message: 'Authentication failed' });
  }
}

// compute required r such that ((p+r)/(t+r))*100 >= 75
function computeRequired(present, total) {
  if (total === 0) return 0;
  const current = (present / total) * 100;
  if (current >= 75) return 0;
  let r = 0;
  while (true) {
    const pct = ((present + r) / (total + r)) * 100;
    if (pct >= 75) return r;
    r++;
    // safety cap to avoid infinite loop (shouldn't be needed)
    if (r > 2000) return r;
  }
}

function computePercent(present, total) {
  if (total === 0) return 0;
  return +((present / total) * 100).toFixed(2);
}

// Compute how many more classes can be missed while staying >= 75%
// x_max = floor(present / 0.75 - total); clamp to 0
function computeCanMiss(present, total) {
  if (present < 0 || total <= 0) return 0;
  const threshold = 0.75;
  const allowed = Math.floor(present / threshold - total);
  return Math.max(0, allowed);
}

const LMS_BASE = 'https://sbmchlms.com/lms';
const LOGIN_URL = `${LMS_BASE}/site/userlogin`;
const DASHBOARD_URL = `${LMS_BASE}/user/user/dashboard`;
const ATTENDANCE_PAGE_URL = `${LMS_BASE}/user/attendence/subjectbyattendance`;
const ATTENDANCE_API_URL = `${LMS_BASE}/user/attendence/subjectgetdaysubattendence`;
const ORIGIN = 'https://sbmchlms.com';

const DEFAULT_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control': 'no-cache'
};

function cleanText(value) {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function withDefaultHeaders(headers = {}) {
  return { ...DEFAULT_HEADERS, ...headers };
}

async function loginToLms({ username, password }) {
  const jar = new CookieJar();
  const fetchWithCookies = fetchCookie(fetch, jar);
  const client = (url, options = {}) => {
    const headers = withDefaultHeaders(options.headers);
    return fetchWithCookies(url, { ...options, headers });
  };

  const loginPage = await client(LOGIN_URL, { method: 'GET' });
  if (!loginPage.ok) {
    throw new Error(`Login page request failed (${loginPage.status})`);
  }
  const loginHtml = await loginPage.text();
  const $login = cheerio.load(loginHtml);
  const hiddenInputs = {};
  $login('input[type="hidden"]').each((_, el) => {
    const name = $login(el).attr('name');
    if (!name) return;
    hiddenInputs[name] = $login(el).attr('value') ?? '';
  });

  const form = new URLSearchParams();
  form.set('username', username);
  form.set('password', password);
  Object.entries(hiddenInputs).forEach(([key, value]) => form.append(key, value ?? ''));

  const loginResponse = await client(LOGIN_URL, {
    method: 'POST',
    body: form,
    headers: withDefaultHeaders({
      'Content-Type': 'application/x-www-form-urlencoded',
      Origin: ORIGIN,
      Referer: LOGIN_URL
    }),
    redirect: 'manual'
  });

  if ([301, 302, 303].includes(loginResponse.status)) {
    const location = loginResponse.headers.get('location');
    if (location) {
      const destination = new URL(location, LOGIN_URL).toString();
      await client(destination, { method: 'GET' });
    }
  } else {
    const body = await loginResponse.text();
    if (!loginResponse.ok || /invalid username|password/i.test(body)) {
      throw new Error('Login failed: the LMS rejected the credentials or returned an unexpected response.');
    }
  }

  return { client };
}

function parseUpcomingClasses($) {
  const upcoming = [];
  $('.user-progress .lecture-list').each((_, li) => {
    const $li = $(li);
    const avatar = cleanText($li.find('img').attr('src') || $li.find('img').attr('data-src') || '');
    let title = cleanText($li.find('.media-title').first().text());
    if (!title) {
      title = cleanText($li.find('.bmedium').first().text());
    }
    const subtitle = cleanText($li.find('.text-muted').first().text());
    const msAuto = $li.find('.ms-auto').first();
    let location = '';
    let time = '';
    if (msAuto && msAuto.length) {
      location = cleanText(msAuto.find('.bmedium').first().text());
      if (!location) {
        location = cleanText(msAuto.children().first().text());
      }
      time = cleanText(msAuto.find('.text-muted').first().text());
      if (!time && msAuto.children().length > 1) {
        time = cleanText(msAuto.children().eq(1).text());
      }
    }
    upcoming.push({ title, subtitle, location, time, avatar });
  });
  return upcoming;
}

async function fetchStudentDashboard(client, username) {
  const dashboardResponse = await client(DASHBOARD_URL, { method: 'GET' });
  if (!dashboardResponse.ok) {
    throw new Error(`Dashboard request failed (${dashboardResponse.status})`);
  }
  const html = await dashboardResponse.text();
  if (/Student Login/i.test(html) && /Username/i.test(html)) {
    throw new Error('Session invalid – dashboard returned login page.');
  }
  const $ = cheerio.load(html);
  let studentName = cleanText($('h4.mt0').first().text().replace(/Welcome,/i, ''));
  if (!studentName) {
    studentName = username;
  }
  const upcomingClasses = parseUpcomingClasses($);
  return { studentName, upcomingClasses };
}

function parseAttendanceRows(resultPage) {
  if (!resultPage) return [];
  const $ = cheerio.load(resultPage);
  const rows = [];
  
  // Look for .attendance_result table first (like working Puppeteer code)
  const resultBox = $('.attendance_result');
  const table = resultBox.length ? resultBox.find('table') : $('table');
  
  if (!table.length) {
    logger.warn('No attendance table found in result page');
    return [];
  }
  
  table.find('tbody tr').each((_, tr) => {
    const $tr = $(tr);
    const tds = $tr.find('td');
    if (tds.length < 3) return;
    const subject = cleanText($(tds[0]).text());
    const percentText = cleanText($(tds[1]).text());
    const presentText = cleanText($(tds[2]).text());
    const percentMatch = percentText.match(/[\d.]+/);
    const percentValue = percentMatch ? parseFloat(percentMatch[0]) : NaN;
    const ratioMatch = presentText.match(/(\d+)\s*\/\s*(\d+)/);
    const sessionsCompleted = ratioMatch ? parseInt(ratioMatch[1], 10) : 0;
    const totalSessions = ratioMatch ? parseInt(ratioMatch[2], 10) : 0;
    const present = sessionsCompleted;
    const total = totalSessions;
    const absent = total >= present ? total - present : 0;
    const percent = !Number.isNaN(percentValue)
      ? +percentValue.toFixed(2)
      : (total ? +((present / total) * 100).toFixed(2) : 0);
    rows.push({
      subject,
      sessionsCompleted,
      totalSessions,
      present,
      total,
      absent,
      percent
    });
  });
  return rows;
}

async function fetchAttendanceTable(client, { fromDate, toDate, subjectId = '' }) {
  // First, visit the attendance page (like Puppeteer does)
  await client(ATTENDANCE_PAGE_URL, { method: 'GET' });
  
  // Calculate date range (from working Puppeteer code: FROM_DATE = '11-11-2024', TO_DATE = today)
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const defaultFromDate = fromDate || '11-11-2024'; // Default from working code
  const defaultToDate = toDate || `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()}`;
  
  logger.info('Fetching attendance with date range', { 
    fromDate: defaultFromDate, 
    toDate: defaultToDate,
    subjectId: subjectId || 'all'
  });

  const payload = new URLSearchParams();
  payload.set('date', defaultFromDate);
  payload.set('end_date', defaultToDate);
  payload.set('subject', subjectId ?? ''); // Empty string = all subjects

  const response = await client(ATTENDANCE_API_URL, {
    method: 'POST',
    headers: withDefaultHeaders({
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Referer: ATTENDANCE_PAGE_URL,
      Accept: 'application/json, text/javascript, */*; q=0.01'
    }),
    body: payload
  });

  if (!response.ok) {
    throw new Error(`Attendance API request failed (${response.status})`);
  }

  const json = await response.json().catch(() => null);
  if (!json) {
    throw new Error('Attendance API returned an empty response.');
  }
  if (String(json.status) !== '1') {
    if (json.result_page) {
      return parseAttendanceRows(json.result_page);
    }
    return [];
  }
  return parseAttendanceRows(json.result_page || '');
}

// --- Combined scrape function ---
async function scrapeAttendance({ username, password, fromDate, toDate }) {
  logger.debug('scrapeAttendance invoked', { username });
  const { client } = await loginToLms({ username, password });
  const { studentName, upcomingClasses } = await fetchStudentDashboard(client, username);
  const attendanceRows = await fetchAttendanceTable(client, { fromDate, toDate, subjectId: '' });
  return { studentName, upcomingClasses, attendanceRows };
}

// Validation middleware
const validateRequest = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

// --- Routes ---
// Legacy /api/login route - now handled by auth router
app.post('/api/login', [
  body('username').isString().trim().notEmpty().withMessage('username is required'),
  body('password').isString().notEmpty().withMessage('password is required'),
  body('fromDate').optional().isString().trim(),
  body('toDate').optional().isString().trim(),
  validateRequest
], async (req, res) => {
  try {
    const { username, password, fromDate, toDate } = req.body || {};

    // Check if user exists in database
    let user = await getUserByStudentId(username);
    
    // If user doesn't exist, create one
    if (!user) {
      const hash = await bcrypt.hash(password, 10);
      const { rows } = await pool.query(
        `INSERT INTO users (student_id, password_hash, login_count, created_at)
         VALUES ($1, $2, 1, now())
         RETURNING *`,
        [username, hash]
      );
      user = rows[0];
      logger.info('[login] Created new user', { student_id: username });
    } else {
      // User exists - verify password and increment login_count
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) {
        return res.status(401).json({ error: 'Invalid credentials' });
      }
      
      // Increment login_count
      await pool.query(
        `UPDATE users SET login_count = login_count + 1, last_login_at = now() WHERE id = $1`,
        [user.id]
      );
      
      // Get updated user
      user = await getUserById(user.id);
      logger.info('[login] User logged in', { student_id: username, login_count: user.login_count });
    }

    // simple rate-limit: 1 request per 30s per user
    const now = Date.now();
    if (lastLoginAt[username] && (now - lastLoginAt[username] < 30 * 1000)) {
      return res.status(429).json({ error: 'Too many login attempts. Wait 30 seconds.' });
    }
    lastLoginAt[username] = now;

    // Sign token
    const token = signToken({ userId: user.id, student_id: user.student_id });

    // Start scrape in background but also wait short time so client can call attendance soon.
    if (!scrapingStatus[username] || !scrapingStatus[username].running) {
      const status = { running: true, promise: null };
      scrapingStatus[username] = status;
      const job = (async () => {
        try {
          logger.info('[auth] Scrape job started for <username>', { username });
          // Use date range like working Puppeteer code
          const now = new Date();
          const pad = n => String(n).padStart(2, '0');
          const normalizedFrom = fromDate || '11-11-2024'; // Default from working code
          const normalizedTo = toDate || `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()}`;
          
          logger.info('Using date range for scraping', { from: normalizedFrom, to: normalizedTo });
          
          const result = await scrapeAttendance({
            username,
            password,
            fromDate: normalizedFrom,
            toDate: normalizedTo
          });

          const processed = (result.attendanceRows || []).map(row => {
            const present = typeof row.present === 'number' ? row.present : (row.sessionsCompleted ?? 0);
            const total = typeof row.total === 'number' ? row.total : (row.totalSessions ?? 0);
            const absent = Number.isFinite(row.absent) ? row.absent : Math.max(0, total - present);
            const percent = Number.isFinite(row.percent) ? +row.percent.toFixed(2) : computePercent(present, total);
            const required = computeRequired(present, total);
            const margin = computeCanMiss(present, total);
            return {
              subject: row.subject,
              present,
              absent,
              total,
              percent,
              margin,
              required
            };
          });

          const studentName = result.studentName || username;
          const fetchedAt = new Date().toISOString();

          logger.info('Starting database save for scraped data', { 
            username, 
            attendanceCount: processed.length,
            upcomingClassesCount: result.upcomingClasses?.length || 0
          });

          // Delete old data for this username (guarantees fresh data on every login)
          // IMPORTANT: Handle foreign key constraint by setting attendance_id to NULL first, then deleting
          // This works even if the constraint doesn't have ON DELETE SET NULL
          try {
            const deleteClient = await pool.connect();
            try {
              await deleteClient.query('BEGIN');
              
              // First, set attendance_id to NULL in latest_snapshot to break the foreign key reference
              await deleteClient.query('UPDATE latest_snapshot SET attendance_id = NULL WHERE username = $1', [username]);
              
              // Now delete the attendance records (no foreign key violation)
              const deleteAttendanceResult = await deleteClient.query('DELETE FROM attendance WHERE username = $1', [username]);
              
              // Delete the snapshot entry completely
              await deleteClient.query('DELETE FROM latest_snapshot WHERE username = $1', [username]);
              
              // Delete upcoming classes
              const deleteClassesResult = await deleteClient.query('DELETE FROM upcoming_classes WHERE username = $1', [username]);
              
              await deleteClient.query('COMMIT');
              
              logger.info('Deleted old attendance data for user', { 
                username,
                deletedAttendanceRows: deleteAttendanceResult.rowCount,
                deletedClassesRows: deleteClassesResult.rowCount
              });
            } catch (txErr) {
              await deleteClient.query('ROLLBACK');
              throw txErr;
            } finally {
              deleteClient.release();
            }
          } catch (deleteErr) {
            logger.error('Error deleting old data', { username, error: deleteErr.message, stack: deleteErr.stack });
            throw deleteErr; // Re-throw to prevent inserting into stale data
          }

          // Bulk insert attendance records
          if (processed.length > 0) {
            // Use a transaction for better performance and atomicity
            const client = await pool.connect();
            try {
              await client.query('BEGIN');
              
              // Insert records one by one in a transaction (safer for large datasets)
              let insertedCount = 0;
              for (const row of processed) {
                try {
                  await client.query(
                    `INSERT INTO attendance (username, student_name, subject, present, absent, total, percent, margin, required, source)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                    [
                      username,
                      studentName,
                      row.subject,
                      row.present,
                      row.absent,
                      row.total,
                      row.percent,
                      row.margin,
                      row.required,
                      'scraper'
                    ]
                  );
                  insertedCount++;
                } catch (insertErr) {
                  logger.error('Error inserting attendance record', { 
                    username, 
                    subject: row.subject, 
                    error: insertErr.message 
                  });
                  throw insertErr; // Re-throw to rollback transaction
                }
              }
              
              await client.query('COMMIT');
              logger.info('Successfully inserted attendance records', { 
                username, 
                count: insertedCount,
                expected: processed.length 
              });
            } catch (err) {
              await client.query('ROLLBACK');
              logger.error('Transaction failed, rolled back', { 
                username, 
                error: err.message, 
                stack: err.stack 
              });
              throw err;
            } finally {
              client.release();
            }
          } else {
            logger.warn('No attendance records to insert', { username });
          }

          // Insert upcoming classes
          if (result.upcomingClasses && result.upcomingClasses.length > 0) {
            const client = await pool.connect();
            try {
              await client.query('BEGIN');
              
              let insertedClassesCount = 0;
              for (const cls of result.upcomingClasses) {
                try {
                  await client.query(
                    `INSERT INTO upcoming_classes (username, class_id, class_name, start_time, end_time, metadata)
                     VALUES ($1, $2, $3, $4, $5, $6)`,
                    [
                      username,
                      cls.id || cls.class_id || null,
                      cls.name || cls.class_name || cls.title || null,
                      cls.start_time ? new Date(cls.start_time) : null,
                      cls.end_time ? new Date(cls.end_time) : null,
                      JSON.stringify(cls.metadata || cls)
                    ]
                  );
                  insertedClassesCount++;
                } catch (insertErr) {
                  logger.error('Error inserting upcoming class', { 
                    username, 
                    class: cls.name || cls.class_name, 
                    error: insertErr.message 
                  });
                  throw insertErr;
                }
              }
              
              await client.query('COMMIT');
              logger.info('Successfully inserted upcoming classes', { 
                username, 
                count: insertedClassesCount,
                expected: result.upcomingClasses.length 
              });
            } catch (err) {
              await client.query('ROLLBACK');
              logger.error('Upcoming classes transaction failed, rolled back', { 
                username, 
                error: err.message, 
                stack: err.stack 
              });
              throw err;
            } finally {
              client.release();
            }
          } else {
            logger.info('No upcoming classes to insert', { username });
          }

          // Update latest_snapshot - get the most recent attendance record for this user
          const { rows: latestRows } = await pool.query(
            `SELECT id FROM attendance WHERE username = $1 ORDER BY recorded_at DESC LIMIT 1`,
            [username]
          );
          
          if (latestRows.length > 0) {
            await pool.query(
              `INSERT INTO latest_snapshot (username, attendance_id, fetched_at)
               VALUES ($1, $2, now())
               ON CONFLICT (username) DO UPDATE SET
                 attendance_id = EXCLUDED.attendance_id,
                 fetched_at = EXCLUDED.fetched_at`,
              [username, latestRows[0].id]
            );
          }

          // Verify data was actually saved
          const { rows: verifyRows } = await pool.query(
            `SELECT COUNT(*) as count FROM attendance WHERE username = $1`,
            [username]
          );
          const savedCount = parseInt(verifyRows[0]?.count || 0);

          logger.info('Attendance scraped and saved to database', {
            username,
            subjects: processed.length,
            savedToDatabase: savedCount,
            upcomingClasses: result.upcomingClasses?.length || 0,
            verified: savedCount === processed.length
          });

          if (savedCount !== processed.length && processed.length > 0) {
            logger.error('Data verification failed - count mismatch', {
              username,
              expected: processed.length,
              actual: savedCount
            });
          }
        } catch (err) {
          logger.error('Scrape job error', { 
            username, 
            error: err.message, 
            stack: err.stack,
            errorCode: err.code,
            errorDetail: err.detail
          });
          // Log database connection errors specifically
          if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED' || err.message?.includes('connection')) {
            logger.error('Database connection error during scrape', { 
              username,
              error: err.message,
              databaseUrl: DB_URL ? 'configured' : 'missing'
            });
          }
        } finally {
          status.running = false;
        }
      })();
      status.promise = job;
      
      // Optionally wait for scrape to finish (bounded wait for better UX)
      const WAIT_MS = Number(process.env.SCRAPE_WAIT_MS || 12000);
      if (WAIT_MS > 0 && scrapingStatus[username] && scrapingStatus[username].promise) {
        const waitStart = Date.now();
        try {
          await Promise.race([
            scrapingStatus[username].promise,
            new Promise(resolve => setTimeout(resolve, WAIT_MS))
          ]);
          const waited = Date.now() - waitStart;
          if (waited < WAIT_MS) {
            logger.info('[auth/login] waited Xms for scrape to finish', { 
              username, 
              waitedMs: waited 
            });
          } else {
            logger.info('[auth/login] scrape not finished after WAIT_MS', { 
              username, 
              waitMs: WAIT_MS 
            });
          }
        } catch (e) {
          logger.warn('[auth/login] Error waiting for scrape', { 
            username, 
            error: e.message 
          });
        }
      }
    } else {
      logger.info('Scrape already running for user', { username });
    }

    return res.json({ token, user: { id: user.id, student_id: user.student_id, login_count: user.login_count } });
  } catch (err) {
    logger.error('Login endpoint error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/attendance', requireAuth, async (req, res) => {
  try {
    // User is already verified by requireAuth middleware
    const username = req.user.student_id;

    logger.info('[attendance] Checking attendance for user', { username });

    // Step 1: Check latest_snapshot first (fast lookup)
    const { rows: snapshotRows } = await pool.query(
      `SELECT attendance_id, fetched_at FROM latest_snapshot WHERE username = $1`,
      [username]
    );

    // Step 2: If no snapshot exists, return 202 (Pending)
    if (snapshotRows.length === 0) {
      logger.info('[attendance] no snapshot for <username> — returning 202', { username });
      return res.status(202).json({ 
        status: 'pending', 
        message: 'Attendance not yet available. Retry shortly.' 
      });
    }

    const snapshot = snapshotRows[0];
    logger.info('[attendance] latest snapshot found for <username>', { 
      username, 
      attendance_id: snapshot.attendance_id,
      fetched_at: snapshot.fetched_at 
    });

    // Step 3: Query attendance data from database using snapshot
    const { rows: attendanceRows } = await pool.query(
      `SELECT student_name, subject, present, absent, total, percent, margin, required, recorded_at
       FROM attendance
       WHERE username = $1
       ORDER BY recorded_at DESC, subject ASC`,
      [username]
    );

    // If snapshot exists but attendance_id is NULL, scraping completed with no data
    // Return 200 with empty array instead of 202
    if (attendanceRows.length === 0) {
      if (snapshot.attendance_id === null) {
        logger.info('[attendance] Snapshot exists with NULL attendance_id - scraping completed with no data', { username });
        // Return 200 with empty attendance array to indicate scraping completed
        return res.json({
          studentName: username,
          fetchedAt: snapshot.fetched_at?.toISOString() || new Date().toISOString(),
          fromDate: req.query.fromDate || '',
          toDate: req.query.toDate || '',
          attendance: [],
          upcomingClasses: []
        });
      } else {
        logger.warn('[attendance] Snapshot exists but no attendance rows found', { username });
        return res.status(202).json({ 
          status: 'pending', 
          message: 'Attendance not yet available. Retry shortly.' 
        });
      }
    }

    // Get student name from first record (all should have same student_name)
    const studentName = attendanceRows[0]?.student_name || username;
    
    // Get fromDate and toDate from query params or use defaults
    const fromDate = req.query.fromDate || '';
    const toDate = req.query.toDate || '';
    
    // Get the most recent fetched_at timestamp from snapshot
    const fetchedAt = snapshot.fetched_at?.toISOString() || attendanceRows[0].recorded_at?.toISOString() || new Date().toISOString();
    
    logger.info('[attendance] returned snapshot fetchedAt=<timestamp> for <username>', { 
      username, 
      fetchedAt,
      attendanceCount: attendanceRows.length 
    });

    // Query upcoming classes
    const { rows: upcomingClassesRows } = await pool.query(
      `SELECT class_id, class_name, start_time, end_time, metadata
       FROM upcoming_classes
       WHERE username = $1
       ORDER BY start_time ASC`,
      [username]
    );

    // Transform upcoming classes to match expected format
    const upcomingClasses = upcomingClassesRows.map(row => {
      const base = {
        id: row.class_id,
        name: row.class_name,
        start_time: row.start_time?.toISOString(),
        end_time: row.end_time?.toISOString()
      };
      
      // Merge metadata if available
      if (row.metadata) {
        try {
          const metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
          return { ...base, ...metadata };
        } catch (e) {
          return base;
        }
      }
      return base;
    });

    // Transform attendance to match expected format (same as file format)
    const attendance = attendanceRows.map(row => ({
      subject: row.subject,
      present: row.present,
      absent: row.absent,
      total: row.total,
      percent: parseFloat(row.percent) || 0,
      margin: row.margin,
      required: row.required
    }));

    // Return in same format as before (maintains frontend compatibility)
    const response = {
      studentName,
      fetchedAt,
      fromDate,
      toDate,
      attendance,
      upcomingClasses
    };

    logger.debug('[attendance] Returning attendance data', { 
      username, 
      subjects: attendance.length, 
      classes: upcomingClasses.length 
    });
    return res.json(response);
  } catch (err) {
    logger.error('Attendance endpoint error', { error: err.message, stack: err.stack });
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// Health
app.get('/health', (req, res) => res.status(200).json({ status: 'ok', time: Date.now(), timestamp: new Date().toISOString() }));

// health check for Render
app.get('/healthz', (req, res) => {
  return res.status(200).json({ status: 'ok', uptime: process.uptime(), time: new Date().toISOString() });
});

// Async error wrapper helper - MUST be defined before routes that use it
const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// Date-wise attendance route - MUST be before error handler and 404 handler
app.post('/api/attendance/datewise', requireAuth, asyncHandler(async (req, res) => {
  // Add early logging to verify route is hit
  logger.info('[datewise] Route handler invoked', { 
    method: req.method, 
    path: req.path,
    url: req.url,
    hasBody: !!req.body,
    hasUser: !!req.user,
    username: req.user?.student_id 
  })
  
  try {
    logger.info('[datewise] Route hit', { 
      method: req.method, 
      path: req.path,
      hasBody: !!req.body,
      username: req.user?.student_id 
    })
    
    const { date, password } = req.body || {}
    const username = req.user.student_id

    if (!date || typeof date !== 'string') {
      logger.warn('[datewise] Missing or invalid date', { date, type: typeof date })
      return res.status(400).json({ error: 'Date is required (format: DD-MM-YYYY)' })
    }

    if (!password || typeof password !== 'string') {
      logger.warn('[datewise] Missing or invalid password', { hasPassword: !!password, type: typeof password })
      return res.status(400).json({ error: 'Password is required' })
    }

    // Validate date format (DD-MM-YYYY)
    const dateRegex = /^\d{2}-\d{2}-\d{4}$/
    if (!dateRegex.test(date)) {
      logger.warn('[datewise] Invalid date format', { date })
      return res.status(400).json({ error: 'Invalid date format. Use DD-MM-YYYY' })
    }

    logger.info('[datewise] Fetching date-wise attendance', { username, date })

    // Scrape using Puppeteer with timeout (Render free tier has 30s request timeout)
    // Set timeout to 25 seconds to avoid hitting Render's limit
    const SCRAPE_TIMEOUT_MS = 25000 // 25 seconds (Render free tier timeout is ~30s)
    
    const scrapePromise = scrapeDatewiseAttendance({
      username,
      password,
      dateToFetch: date
    })
    
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('Scraping timeout: Request took too long. Render free tier has a 30 second request limit.'))
      }, SCRAPE_TIMEOUT_MS)
    })
    
    const result = await Promise.race([scrapePromise, timeoutPromise])

    logger.info('[datewise] Successfully fetched attendance', { 
      username, 
      date, 
      rowCount: result.rows?.length || 0 
    })

    return res.json(result)

  } catch (err) {
    // Get date from request body (might not be in scope if error occurred early)
    const requestDate = req.body?.date || 'unknown'
    
    logger.error('[datewise] Error fetching date-wise attendance', {
      error: err.message,
      stack: err.stack,
      username: req.user?.student_id,
      name: err.name,
      code: err.code,
      date: requestDate
    })

    // Return user-friendly error message
    const errorMessage = err.message || 'Failed to fetch date-wise attendance'
    
    // Determine status code based on error type
    let statusCode = 500
    if (errorMessage.includes('Browser service unavailable') || 
        errorMessage.includes('Puppeteer cannot launch') ||
        errorMessage.includes('Could not find Chrome') ||
        errorMessage.includes('timeout') ||
        errorMessage.includes('Scraping timeout')) {
      statusCode = 503
    } else if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
      statusCode = 504 // Gateway Timeout
    }

    logger.error('[datewise] Returning error response', {
      statusCode,
      errorMessage,
      username: req.user?.student_id,
      date: requestDate
    })

    return res.status(statusCode).json({
      error: 'Failed to fetch date-wise attendance',
      message: errorMessage,
      // Include more details in development
      ...(process.env.NODE_ENV === 'development' && {
        details: {
          code: err.code,
          name: err.name,
          stack: err.stack
        }
      })
    })
  }
}))

// Error handling middleware - MUST be after all routes but before 404
app.use((err, req, res, _next) => {
  logger.error('Unhandled error', { message: err.message, stack: err.stack, url: req.url, method: req.method });

  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({ error: 'CORS policy: origin not allowed' });
  }

  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'internal_server_error' : err.message
  });
});

// 404 handler - MUST be last
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Export app for testing
export { app };

// Only start server if not in test environment
if (process.env.NODE_ENV !== 'test') {
  // Ensure DB schema on boot (non-blocking)
  ensureSchema().catch((e) => logger.error('ensureSchema boot error', { error: e.message }));
  
  // Initialize cron jobs if needed
  try {
    const { startSubscriptionNotifier } = await import('./cron/subscriptionNotifier.js');
    startSubscriptionNotifier();
    logger.info('[cron] Subscription notifier cron job started');
  } catch (err) {
    logger.warn('[cron] Failed to start subscription notifier', { error: err.message });
  }
  
  // Handle unhandled promise rejections to prevent crashes
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Promise Rejection', {
      reason: reason?.message || String(reason),
      code: reason?.code,
      stack: reason?.stack,
    });
    // Don't exit - just log the error
  });

  // Handle uncaught exceptions
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught Exception', {
      error: err.message,
      code: err.code,
      stack: err.stack,
    });
    // Don't exit immediately - give time for graceful shutdown
    setTimeout(() => {
      process.exit(1);
    }, 1000);
  });

  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Attendance API server running on http://0.0.0.0:${PORT}`);
    if (!process.env.SECRET) {
      logger.warn('SECRET env var not set - using dev secret. Set SECRET in production!');
    }
    // Log registered routes for debugging
    logger.info('Registered routes:', {
      routes: [
        'POST /api/login',
        'GET /api/attendance',
        'POST /api/attendance/datewise',
        'GET /health',
        'GET /healthz'
      ]
    });
  });

  // Graceful shutdown handlers
  const shutdown = async (signal) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    try {
      await cleanupBrowserPool();
      await closeDbPool();
      logger.info('Graceful shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown', { error: err.message });
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
