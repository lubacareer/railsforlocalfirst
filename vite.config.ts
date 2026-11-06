import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

export function productionCsp(): Plugin {
  return {
    name: 'production-csp',
    transformIndexHtml(_html, context) {
      if (context.server) return [];
      return [{
        tag: 'meta',
        attrs: {
          'http-equiv': 'Content-Security-Policy',
          content: "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self';",
        },
        injectTo: 'head-prepend',
      }];
    },
  };
}

export default defineConfig({
  plugins: [react(), productionCsp()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: false,
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});

