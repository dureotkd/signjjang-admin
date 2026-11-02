import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  return {
    base: '/admin/',
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        '/api': {
          target: env.ADMIN_API_PROXY || 'http://127.0.0.1:4000',
          changeOrigin: true,
          configure(proxy) {
            // The browser calls this same-origin dev server; forward it as a server request.
            proxy.on('proxyReq', request => request.removeHeader('origin'));
          },
        },
      },
    },
    build: { outDir: 'dist', emptyOutDir: true },
  };
});
