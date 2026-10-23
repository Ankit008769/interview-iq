import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({ test: { include: ['tests/**/*.test.ts'], env: {
  MONGOMS_VERSION: '8.2.6',
  MONGOMS_DOWNLOAD_DIR: fileURLToPath(new URL('./node_modules/.cache/mongodb-memory-server', import.meta.url)),
} } });
