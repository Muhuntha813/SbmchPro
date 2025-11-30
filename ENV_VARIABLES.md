# Environment Variables Documentation

## Frontend Environment Variables

### Required (Optional - has fallback)
- **`VITE_API_URL`** (Optional)
  - Description: Backend API base URL for the frontend to connect to
  - Default: `http://localhost:3000` (if not set, auto-detection is used)
  - Example: `https://your-backend.onrender.com`
  - Used in: `frontend/src/config/api.js`, `frontend/src/config/apiDetector.js`, `frontend/src/hooks/useAttendance.js`, `frontend/src/App.jsx`
  - Note: Frontend can auto-detect the backend URL if not provided

### Frontend Structure
- ✅ Has its own `package.json` at `frontend/package.json`
- ✅ Frontend code is self-contained in `frontend/` directory
- ✅ Builds independently using Vite
- ✅ No backend dependencies in frontend code

---

## Backend Environment Variables

### Required
- **`SECRET`** or **`JWT_SECRET`** (Required in production)
  - Description: Secret key for JWT token signing and verification
  - Minimum: 32 characters recommended
  - Default: `dev-secret-for-local` (development only)
  - Used in: `backend/attendance.js`, `backend/routes/auth.js`
  - Note: Backend will exit if not set in production mode

- **`DATABASE_URL`** (Required)
  - Description: PostgreSQL database connection string
  - Format: `postgresql://user:password@host:port/database`
  - Example: `postgresql://user:pass@db.example.com:5432/mydb`
  - Used in: `backend/src/sharedDb.js`, `backend/src/db.js`, `backend/attendance.js`
  - Note: Backend will fail if not configured

### Optional
- **`PORT`** (Optional)
  - Description: Port number for the backend server
  - Default: `3000`
  - Used in: `backend/attendance.js`

- **`NODE_ENV`** (Optional)
  - Description: Environment mode (development/production/test)
  - Default: `development`
  - Values: `development`, `production`, `test`
  - Used in: `backend/attendance.js`, `backend/lib/logger.js`, `backend/routes/auth.js`

- **`FRONTEND_URL`** (Optional)
  - Description: Comma-separated list of allowed CORS origins
  - Format: `https://example.com,https://www.example.com`
  - Default: `http://localhost:5173` (development)
  - Used in: `backend/attendance.js`

- **`SCRAPER_URL`** (Optional)
  - Description: External scraper service URL for verification
  - Default: Empty (disabled)
  - Used in: `backend/attendance.js`, `backend/routes/auth.js`

- **`SCRAPER_TIMEOUT_MS`** (Optional)
  - Description: Timeout for scraper requests in milliseconds
  - Default: `5000`
  - Used in: `backend/routes/auth.js`

- **`SCRAPE_WAIT_MS`** (Optional)
  - Description: Wait time between scraping operations in milliseconds
  - Default: `12000`
  - Used in: `backend/attendance.js`

- **`ADMIN_API_KEY`** (Optional)
  - Description: API key for admin routes
  - Default: Empty (admin routes disabled)
  - Used in: `backend/routes/admin.js`

- **`LOG_LEVEL`** (Optional)
  - Description: Logging level (debug, info, warn, error)
  - Default: `debug` (development), `info` (production)
  - Used in: `backend/lib/logger.js`

- **`SUBSCRIPTION_CRON_SCHEDULE`** (Optional)
  - Description: Cron schedule for subscription notifications
  - Default: `0 * * * *` (every hour)
  - Format: Cron expression
  - Used in: `backend/cron/subscriptionNotifier.js`

### Backend Structure
- ✅ Has its own `package.json` at `backend/package.json`
- ✅ Backend code is self-contained in `backend/` directory
- ✅ Runs independently using Node.js
- ✅ Loads `.env` from project root (where `backend/` folder is located)

---

## Summary

### Frontend
- **Essential Env**: None (all optional with fallbacks)
- **Recommended Env**: `VITE_API_URL` (for production deployment)

### Backend
- **Essential Env**:
  1. `SECRET` or `JWT_SECRET` (required in production)
  2. `DATABASE_URL` (required)
- **Recommended Env**:
  1. `PORT` (if not using default 3000)
  2. `NODE_ENV=production` (for production)
  3. `FRONTEND_URL` (for CORS in production)

---

## Deployment Notes

### Frontend (Vercel)
- Set `VITE_API_URL` in Vercel environment variables
- Frontend will auto-detect backend if not set (not recommended for production)

### Backend (Render)
- Set `SECRET` or `JWT_SECRET` (required)
- Set `DATABASE_URL` (required)
- Set `PORT` (optional, Render provides this)
- Set `NODE_ENV=production`
- Set `FRONTEND_URL` with your Vercel frontend URL

