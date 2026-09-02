import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Bind IPv4 explicitly. Vite's default resolves "localhost" to ::1 on
    // Windows, but *.localhost subdomains resolve to 127.0.0.1 only — so a
    // default-bound server refuses demo.localhost while plain localhost works.
    host: '127.0.0.1',
    // Tenants are addressed as <slug>.localhost in development; browsers
    // resolve any *.localhost to 127.0.0.1 with no hosts-file entry.
    allowedHosts: ['.localhost'],
    // Proxying keeps the browser on one origin, so screenshot <img> tags can
    // carry the auth header path without CORS or cookie games.
    //
    // changeOrigin stays false so the tenant subdomain survives in the Host
    // header. The client also sends X-Org-Slug, so tenancy does not depend on
    // this alone — but leaving Host intact keeps dev matching production.
    proxy: {
      // ws:true is what carries the chat socket (/api/v1/chat/ws) through the
      // dev proxy. Without it the handshake is proxied as plain HTTP and chat
      // sits on "Reconnecting" while every other call works.
      '/api': { target: 'http://127.0.0.1:8000', changeOrigin: false, ws: true },
    },
  },
})
