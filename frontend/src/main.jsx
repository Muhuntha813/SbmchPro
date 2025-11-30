import React, { Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/globals.css'

// Lazy load App component for code splitting and better initial load performance
const App = React.lazy(() => import('./App.jsx'))

// Initialize 3-theme system before rendering with error handling
const THEME_KEY = 'ATT_THEME'
let initialTheme = 'cool-down-buddy' // Default fallback

try {
  // Try to get saved theme from localStorage
  const saved = localStorage.getItem(THEME_KEY)
  if (saved) {
    initialTheme = saved
  } else {
    // Try to detect system preference with fallback
    try {
      const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
      initialTheme = prefersDark ? 'cool-down-buddy' : 'daylight-bliss'
    } catch (e) {
      // matchMedia not supported, use default
      console.warn('[Theme] matchMedia not supported, using default theme')
    }
  }
  
  // Migrate old values
  if (initialTheme === 'dark') initialTheme = 'cool-down-buddy'
  if (initialTheme === 'light') initialTheme = 'daylight-bliss'
} catch (e) {
  // localStorage blocked or unavailable, use default
  console.warn('[Theme] localStorage unavailable, using default theme:', e.message)
}

// Apply theme classes with error handling
try {
  const darkThemes = ['cool-down-buddy', 'midnight-drift']
  document.documentElement.classList.toggle('dark', darkThemes.includes(initialTheme))
  document.body.classList.remove('theme-cool', 'theme-midnight', 'theme-daylight')
  const themeClassMap = {
    'cool-down-buddy': 'theme-cool',
    'midnight-drift': 'theme-midnight',
    'daylight-bliss': 'theme-daylight'
  }
  document.body.classList.add(themeClassMap[initialTheme] || 'theme-cool')
  
  // Try to save theme, but don't fail if localStorage is blocked
  try {
    localStorage.setItem(THEME_KEY, initialTheme)
  } catch (e) {
    // localStorage write failed, but theme is already applied
    console.warn('[Theme] Could not save theme to localStorage:', e.message)
  }
} catch (e) {
  // DOM manipulation failed, apply default theme
  console.error('[Theme] Failed to apply theme classes:', e.message)
  document.body.classList.add('theme-cool')
  document.documentElement.classList.add('dark')
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900">
        <div className="text-center">
          <div className="w-12 h-12 border-4 border-white/20 border-t-white/80 rounded-full animate-spin mx-auto mb-4"></div>
          <p className="text-white/70 text-sm">Loading...</p>
        </div>
      </div>
    }>
      <App />
    </Suspense>
  </React.StrictMode>
)