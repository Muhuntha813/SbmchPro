# Render Deployment Guide

## Quick Setup Steps

### 1. Create Web Service on Render

1. Go to [Render Dashboard](https://dashboard.render.com)
2. Click **"New +"** → **"Web Service"**
3. Connect your GitHub repository: `https://github.com/Muhuntha813/SbmchPro`
4. Render will auto-detect the `render.yaml` configuration

### 2. Configure Environment Variables (CRITICAL)

**⚠️ REQUIRED - Add these in Render Dashboard → Environment tab:**

1. **`SECRET`** or **`JWT_SECRET`** (REQUIRED)
   - Generate a secure random string (minimum 32 characters)
   - You can generate one using: `openssl rand -base64 32`
   - Or use an online generator: https://randomkeygen.com/
   - Example: `a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6`
   - **Without this, your backend will crash on startup!**

2. **`DATABASE_URL`** (REQUIRED)
   - Your PostgreSQL connection string
   - Format: `postgresql://user:password@host:port/database`
   - If using Render PostgreSQL: Copy from Render PostgreSQL dashboard
   - If using Supabase: Copy from Supabase project settings → Database

3. **`NODE_ENV`** (RECOMMENDED)
   - Set to: `production`

4. **`FRONTEND_URL`** (⚠️ REQUIRED for CORS - Backend will reject requests without this!)
   - Your Vercel frontend URL (the exact URL where your frontend is deployed)
   - Example: `https://your-app.vercel.app`
   - For multiple origins (staging + production): `https://app.vercel.app,https://app-staging.vercel.app`
   - **Important**: Include the protocol (`https://`) and no trailing slash
   - **Without this, you'll get "Not allowed by CORS" errors!**

### 3. Service Configuration

Render should auto-detect from `render.yaml`, but verify:

- **Root Directory**: `backend`
- **Build Command**: `npm install`
- **Start Command**: `npm start`
- **Environment**: `Node`

### 4. Deploy

1. Click **"Create Web Service"**
2. Render will automatically:
   - Clone your repository
   - Install dependencies
   - Start your backend
3. Wait for deployment to complete

## Troubleshooting

### Error: "FATAL: SECRET env var is required in production"

**Cause**: The `SECRET` or `JWT_SECRET` environment variable is not set.

**Solution**:
1. Go to Render Dashboard → Your Service → Environment
2. Click **"Add Environment Variable"**
3. Add:
   - Key: `SECRET`
   - Value: (generate a secure random string, min 32 chars)
4. Click **"Save Changes"**
5. Render will automatically redeploy

### Error: "DATABASE_URL not configured"

**Cause**: The `DATABASE_URL` environment variable is not set.

**Solution**:
1. Create a PostgreSQL database on Render (or use Supabase)
2. Copy the connection string
3. Add it as `DATABASE_URL` in Render Environment Variables

### Service Keeps Crashing

Check the logs in Render Dashboard:
1. Go to your service → **"Logs"** tab
2. Look for error messages
3. Common issues:
   - Missing `SECRET` → Add it (see above)
   - Missing `DATABASE_URL` → Add it
   - Database connection failed → Check `DATABASE_URL` format
   - Port issues → Render provides `PORT` automatically

## Environment Variables Summary

### Required (Service won't start without these)
- ✅ `SECRET` or `JWT_SECRET` - JWT signing secret (min 32 chars)
- ✅ `DATABASE_URL` - PostgreSQL connection string

### Recommended
- `NODE_ENV=production` - Sets production mode
- `FRONTEND_URL` - Your frontend URL for CORS

### Optional
- `PORT` - Render provides this automatically
- `SCRAPER_URL` - External scraper service
- `SCRAPER_TIMEOUT_MS` - Default: 5000
- `SCRAPE_WAIT_MS` - Default: 12000
- `ADMIN_API_KEY` - For admin routes
- `LOG_LEVEL` - Default: info
- `SUBSCRIPTION_CRON_SCHEDULE` - Default: hourly

## Testing Your Deployment

Once deployed, test these endpoints:

1. **Health Check**: `https://your-service.onrender.com/health`
   - Should return: `{"status":"ok"}`

2. **Healthz Check**: `https://your-service.onrender.com/healthz`
   - Should return: `{"status":"ok"}`

3. **Login Endpoint**: `https://your-service.onrender.com/api/auth/login`
   - Should accept POST requests with `student_id` and `password`

## Next Steps

After backend is deployed:
1. Copy your backend URL (e.g., `https://your-service.onrender.com`)
2. Deploy frontend on Vercel
3. Set `VITE_API_URL` in Vercel to your backend URL

