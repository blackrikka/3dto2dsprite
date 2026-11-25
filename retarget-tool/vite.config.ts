import { defineConfig, type Plugin } from 'vite';

/**
 * file:// 로 dist/index.html 을 열어도 동작하도록 한다.
 * Chrome 은 file:// 에서 type="module" 스크립트와 crossorigin 리소스를 CORS 로 막으므로,
 * 단일 IIFE 번들을 defer 일반 스크립트로 싣는다.
 */
const fileProtocolFriendly = (): Plugin => ({
  name: 'file-protocol-friendly',
  enforce: 'post',
  transformIndexHtml: {
    order: 'post',
    handler: (html) =>
      html
        .replace(/<script type="module" crossorigin src="([^"]+)"><\/script>/g, '<script defer src="$1"></script>')
        .replace(/<link rel="stylesheet" crossorigin /g, '<link rel="stylesheet" '),
  },
});

export default defineConfig({
  base: './',
  plugins: [fileProtocolFriendly()],
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: { format: 'iife' },
    },
  },
});
