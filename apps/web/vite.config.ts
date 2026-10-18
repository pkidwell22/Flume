import { defineConfig } from 'vite';

const apiOrigin = new URL(process.env.FLUME_API_URL ?? 'http://127.0.0.1:4311');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(apiOrigin.hostname) || apiOrigin.protocol !== 'http:' || apiOrigin.username || apiOrigin.password || apiOrigin.pathname !== '/' || apiOrigin.search || apiOrigin.hash) {
  throw new Error('FLUME_API_URL must be a plain loopback HTTP origin.');
}
export default defineConfig({
  server: { host: '127.0.0.1', port: 4310, strictPort: true, allowedHosts: ['localhost'], proxy: { '/api': { target: apiOrigin.origin, changeOrigin: false } } },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  build: { target: 'es2022' },
});
