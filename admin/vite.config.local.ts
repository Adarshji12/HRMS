// Local-only override for this machine, where both default ports are taken:
//   8000 -> a Django app served out of WSL, so the API runs on 8001
//
// If 8001 ever answers with a stale build after you restart the API, look for an
// orphaned `uvicorn --reload` CHILD: the reloader forks, and killing the parent
// leaves the child holding the socket. Find it with
//   Get-CimInstance Win32_Process | ? { $_.Name -eq 'python.exe' }
// and kill the one whose parent PID no longer exists.
//   5173 and 5174 -> Vite dev servers from D:\chatwo, so this console runs on
//                    5199. Note Windows happily lets a second socket bind an
//                    occupied port here, so strictPort does not catch that
//                    collision — the port was chosen off a listener scan.
// Identical to vite.config.ts apart from those two numbers. Not committed —
// run with:  npm run dev -- --config vite.config.local.ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5199,
    strictPort: true,
    host: '127.0.0.1',
    allowedHosts: ['.localhost'],
    proxy: {
      '/api': { target: 'http://127.0.0.1:8001', changeOrigin: false },
    },
  },
})
