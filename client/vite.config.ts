import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sep } from 'node:path';

// The system-design board's fonts are served by the app itself (window.EXCALIDRAW_ASSET_PATH), not from a CDN.
// The 13 MB CJK fallback font is left out; Excalidraw fetches it from its CDN only if such text is drawn.
const fonts = fileURLToPath(new URL('./node_modules/@excalidraw/excalidraw/dist/prod/fonts', import.meta.url));
const target = fileURLToPath(new URL('./public/excalidraw-assets/fonts', import.meta.url));
if (existsSync(fonts)) cpSync(fonts, target, { recursive: true, filter: source => !source.split(sep).includes('Xiaolai') });

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': 'http://127.0.0.1:5000' } },
});
