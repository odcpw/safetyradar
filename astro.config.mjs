import { defineConfig } from 'astro/config';
// Preview on GitHub Pages at https://safetyradar.ch: SITE=https://safetyradar.ch BASE=/ NOINDEX=1 (see .github/workflows/pages.yml)
export default defineConfig({
  site: process.env.SITE || 'https://safetyradar.ch',
  base: process.env.BASE || '/',
  build: { format: 'directory' },
});
