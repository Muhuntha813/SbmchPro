import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  root: __dirname,
  build: {
    // When building from root (via --config), output to root dist/
    // When building from frontend/, output to frontend/dist/
    outDir: process.env.VERCEL ? path.resolve(process.cwd(), 'dist') : path.resolve(__dirname, 'dist'),
    emptyOutDir: true,
  },
})

