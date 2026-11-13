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

// Video self-review runs MediaPipe in the browser from the app's own files (the face model is committed in
// public/mediapipe). Only the main-thread WebAssembly builds, with and without SIMD, are copied.
const wasm = fileURLToPath(new URL('./node_modules/@mediapipe/tasks-vision/wasm', import.meta.url));
const wasmTarget = fileURLToPath(new URL('./public/mediapipe/wasm', import.meta.url));
if (existsSync(wasm)) cpSync(wasm, wasmTarget, { recursive: true, filter: source => !/module_internal/.test(source) });

export default defineConfig({
  plugins: [react()],
  // The dev server forwards /api to the local API; API_PROXY_TARGET moves it off port 5000 when that is taken.
  server: { proxy: { '/api': process.env.API_PROXY_TARGET || 'http://127.0.0.1:5000' } },
});
