# Render Puppeteer/Date-wise Attendance Issues

## Problem

Date-wise attendance returns **503 Service Unavailable** on Render free tier.

## Root Causes

1. **Render Free Tier Limitations:**
   - **30 second request timeout** - Requests that take longer are killed
   - **512MB RAM limit** - Puppeteer/Chromium needs significant memory
   - **No persistent storage** - Browser instances can't persist between requests

2. **Puppeteer Issues:**
   - Chromium launch can fail due to memory constraints
   - Browser scraping takes 15-25+ seconds (can exceed timeout)
   - Multiple browser instances can cause OOM (Out of Memory)

## Solutions Implemented

### 1. Timeout Wrapper (25 seconds)
- Added timeout wrapper around scraping function
- Prevents hitting Render's 30s limit
- Returns clear error message if timeout occurs

### 2. Reduced Puppeteer Timeouts (18 seconds)
- Changed page timeout from 20s to 18s
- Leaves buffer for other operations
- Protocol timeout also set to 18s

### 3. Memory Optimizations
- Added `--single-process` flag (critical for 512MB limit)
- Added `--memory-pressure-off` flag
- Browser pool limits to 2 concurrent browsers max

### 4. Better Error Handling
- Detects timeout errors specifically
- Returns 503 for browser unavailable
- Returns 504 for timeout errors
- Better logging for debugging

## Current Status

The code now:
- ✅ Has 25s timeout wrapper
- ✅ Uses optimized Puppeteer args for low memory
- ✅ Falls back to direct Puppeteer if pool fails
- ✅ Returns appropriate HTTP status codes

## Known Limitations on Render Free Tier

1. **Request Timeout**: If scraping takes >25 seconds, it will timeout
2. **Memory**: If multiple requests come in, browser pool may fail
3. **Cold Starts**: First request after idle period may be slower

## Recommendations

### For Production (Render Paid Tier)
- Upgrade to paid tier for:
  - Longer request timeouts (up to 5 minutes)
  - More RAM (1GB+)
  - Better performance

### Alternative Solutions
1. **Use Background Jobs**: Move scraping to background worker
2. **External Browser Service**: Use services like Browserless.io
3. **API-based Solution**: If LMS has API, use that instead of scraping

## Monitoring

Check Render logs for:
- `[datewise]` - Date-wise attendance logs
- `[browserPool]` - Browser pool status
- `[datewiseAttendance]` - Scraping process logs
- Timeout errors
- Memory errors

## Debugging

If date-wise still fails:
1. Check Render logs for specific error
2. Look for "timeout" or "Browser service unavailable" messages
3. Check if browser pool is creating browsers successfully
4. Verify Puppeteer can launch on Render (check logs on startup)


