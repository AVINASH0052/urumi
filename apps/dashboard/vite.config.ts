import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// `npm run dev` proxies the API to a gateway on :13100 (or GATEWAY_URL).
export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': process.env.GATEWAY_URL ?? 'http://127.0.0.1:13100' } },
});
