// src/config/api.js
// Centralized API base URL configuration
// Supports both Create React App (REACT_APP_*) and Vite (VITE_*) environment variables

/**
 * Get API base URL with proper fallback logic
 * Priority: Environment variable > localStorage override > localhost (dev only) > null
 */
export function getApiBase() {
  // Check environment variables first (highest priority)
  const reactApi = typeof process !== 'undefined' && process.env ? process.env.REACT_APP_API_URL : undefined;
  const viteApi = (typeof import.meta !== 'undefined' && import.meta.env) ? import.meta.env.VITE_API_URL : undefined;
  const fallbackApi = typeof process !== 'undefined' && process.env ? process.env.API_BASE : undefined;
  
  // Check localStorage override
  const override = typeof window !== 'undefined' ? localStorage.getItem('API_OVERRIDE') : null;
  
  // Only use localhost as fallback in development mode
  const isDevelopment = (typeof import.meta !== 'undefined' && import.meta.env) 
    ? import.meta.env.MODE === 'development' || import.meta.env.DEV
    : typeof window !== 'undefined' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
  
  return reactApi || viteApi || fallbackApi || override || (isDevelopment ? 'http://localhost:3000' : null);
}

// Legacy export for backward compatibility
export const API_BASE = getApiBase();
export default API_BASE;

