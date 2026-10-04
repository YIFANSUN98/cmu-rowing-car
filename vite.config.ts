import { defineConfig } from 'vite';
export default defineConfig({
  base: '/cmu-rowing-car/',
  // Prebundle the lazy map library before planning; discovering it on expansion
  // would otherwise reload the development page and discard the uploaded files.
  optimizeDeps: { include: ['leaflet'] },
  build: { target: 'es2022' },
  server: {
    proxy: { '/cmu-rowing-car/api': { target: 'http://127.0.0.1:5174', changeOrigin: false } },
    fs: {
      deny: [
        '.env',
        '.env.*',
        '**/.git/**',
        '**/data/private/**',
        '**/exports/private/**',
        '**/*.xlsx',
        '**/*.xls',
        '**/*.pem',
        '**/*.key',
      ],
    },
  },
});
