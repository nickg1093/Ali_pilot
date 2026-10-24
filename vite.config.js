import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
export default defineConfig({
  server: { proxy: { '/api': 'http://localhost:10000' } },
  plugins: [react(), VitePWA({ registerType: 'autoUpdate', navigateFallbackDenylist: [/^\/api\//, /^\/debug-marea\/?$/], includeAssets: ['favicon.svg', 'icons/icon-192.png', 'icons/icon-512.png'], manifest: { name: 'Alilaguna Pilot', short_name: 'Alilaguna', description: 'Navigazione GPS e controllo soglie di marea', theme_color: '#082f49', background_color: '#f3f7fa', display: 'standalone', start_url: '/', icons: [{ src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' }, { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' }] } })]
});
