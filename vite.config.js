import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
export default defineConfig({
  server: { proxy: { '/api': 'http://localhost:10000' } },
  plugins: [react(), VitePWA({ registerType: 'autoUpdate', includeAssets: ['favicon.svg'], manifest: { name: 'Laguna Pilot', short_name: 'Laguna Pilot', description: 'Navigazione GPS e controllo soglie di marea', theme_color: '#082f49', background_color: '#f3f7fa', display: 'standalone', start_url: '/', icons: [{ src: '/icons/icon-192.svg', sizes: '192x192', type: 'image/svg+xml', purpose: 'any' }, { src: '/icons/icon-512.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any' }] } })]
});
