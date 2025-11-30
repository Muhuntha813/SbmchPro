import React, { Suspense } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/globals.css'

// Lazy load App component for code splitting and better initial load performance
const App = React.lazy(() => import('./App.jsx'))

// Initialize 3-theme system before rendering
const THEME_KEY = 'ATT_THEME'
let initialTheme = localStorage.getItem(THEME_KEY)
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
if (!initialTheme) {
  initialTheme = prefersDark ? 'cool-down-buddy' : 'daylight-bliss'
}
// Migrate old values
if (initialTheme === 'dark') initialTheme = 'cool-down-buddy'
if (initialTheme === 'light') initialTheme = 'daylight-bliss'

const darkThemes = ['cool-down-buddy', 'midnight-drift']
document.documentElement.classList.toggle('dark', darkThemes.includes(initialTheme))
document.body.classList.remove('theme-cool', 'theme-midnight', 'theme-daylight')
const themeClassMap = {
  'cool-down-buddy': 'theme-cool',
  'midnight-drift': 'theme-midnight',
  'daylight-bliss': 'theme-daylight'
}
document.body.classList.add(themeClassMap[initialTheme] || 'theme-cool')
localStorage.setItem(THEME_KEY, initialTheme)

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