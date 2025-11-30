import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const cwd = process.cwd()

// Detect if we're building from root (when --config is used) or from frontend/
// If cwd is different from __dirname, we're building from root
const isBuildingFromRoot = cwd !== __dirname

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  root: __dirname,
  build: {
    // When building from root (Vercel), output to root dist/
    // When building from frontend/, output to frontend/dist/
    outDir: isBuildingFromRoot ? path.resolve(cwd, 'dist') : path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
})

