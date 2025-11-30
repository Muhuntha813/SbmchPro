# SBMCH Attendance Dashboard

Simple attendance dashboard for SBMCH students (React + Vite frontend, Express backend).

## Features

- React + Vite frontend
- Express.js backend with scraping logic
- JWT auth
- Rate limiting, Helmet, CORS restrictions, validation
- `/health` and `/healthz` endpoints

## Quick Setup (Local)

### Install dependencies:

```bash
npm ci
```

### Create `.env` from `.env.example`:

```bash
cp .env.example .env
```

### Development:

- **Backend**: `npm run server` (or `node backend/server.js`)
- **Frontend**: `npm run dev`

### Tests & Lint:

```bash
npm test
npm run lint
```

## Deployment (Render Example)

### Backend (Render - Web Service)

**Option 1: Using render.yaml (Recommended)**
- The repository includes a `render.yaml` file
- Connect your GitHub repo to Render
- Render will automatically detect and use the configuration

**Option 2: Manual Configuration**
- **Root Directory**: `backend`
- **Build Command**: `npm install` (or leave empty - backend doesn't need build)
- **Start Command**: `npm start`

**⚠️ REQUIRED Environment Variables on Render (Add in Dashboard → Environment):**

1. **`SECRET` or `JWT_SECRET`** (REQUIRED - Service will crash without this!)
   - Generate: `openssl rand -base64 32` or use https://randomkeygen.com/
   - Minimum 32 characters
   - Example: `a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6`

2. **`DATABASE_URL`** (REQUIRED - PostgreSQL connection string)
   - Format: `postgresql://user:password@host:port/database`
   - Get from Render PostgreSQL or Supabase dashboard

3. **`NODE_ENV=production`** (Recommended)

4. **`FRONTEND_URL`** (Optional - for CORS)
   - Your Vercel frontend URL
   - Example: `https://your-app.vercel.app`
- `PORT` (optional, Render provides this automatically)

**Optional Environment Variables:**

- `SCRAPER_URL` (optional)
- `SCRAPER_TIMEOUT_MS` (optional, default: 5000)
- `SCRAPE_WAIT_MS` (optional, default: 12000)
- `ADMIN_API_KEY` (optional)
- `LOG_LEVEL` (optional, default: info)
- `SUBSCRIPTION_CRON_SCHEDULE` (optional, default: hourly)

### Frontend (Render - Static Site)

- **Root Directory**: `frontend`
- **Build Command**: `npm ci && npm run build`
- **Publish Directory**: `dist`
- **Build-time env**: `VITE_API=https://<your-backend>.onrender.com`

## Docker (Local Test)

Build and run:

```bash
docker build -t sbmch-attendance .
docker run -e SECRET=your-jwt-secret -p 3000:3000 sbmch-attendance
```

## Logging & Monitoring

This project includes Winston for structured logs. You can enable Sentry by providing `SENTRY_DSN` in your environment.

## Contributing

Create PRs against main. CI runs build, lint, tests.

