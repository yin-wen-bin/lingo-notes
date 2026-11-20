import { defineConfig, loadEnv } from 'vite';
import { fileURLToPath } from 'node:url';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, root, 'VITE_');
  let origin = '';
  try { origin = new URL(env.VITE_SUPABASE_URL || process.env.VITE_SUPABASE_URL || '').origin; } catch { /* Unconfigured builds show setup state. */ }
  const development = command === 'serve';
  const connections = ["'self'", origin, ...(development ? ['ws://localhost:*', 'ws://127.0.0.1:*'] : [])].filter(Boolean).join(' ');
  const csp = `default-src 'none'; script-src 'self'; style-src 'self'${development ? " 'unsafe-inline'" : ''}; img-src 'self' blob: ${origin}; connect-src ${connections}; font-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'self'; form-action 'self'; object-src 'none'`;
  return {
    root,
    build: { outDir: 'dist', emptyOutDir: true, target: 'es2022', assetsInlineLimit: 0 },
    plugins: [{
      name: 'lingo-private-shell',
      transformIndexHtml(html: string) { return html.replace('__LINGO_CSP__', csp); },
      generateBundle(_options, bundle) {
        const assets = Object.keys(bundle).filter(name => name.startsWith('assets/') && /\.(js|css)$/.test(name)).sort().map(name => `/${name}`);
        const fonts = Object.keys(bundle).filter(name => name.startsWith('assets/') && name.endsWith('.woff2')).sort().map(name => `/${name}`);
        const template = readFileSync(new URL('./service-worker.js', import.meta.url), 'utf8');
        const version = createHash('sha256').update(template).update(JSON.stringify({ assets, fonts })).digest('hex').slice(0, 12);
        const source = template
          .replace('__CACHE_VERSION__', version)
          .replace('/*__BUILD_ASSETS__*/', assets.map(name => JSON.stringify(name)).join(','))
          .replace('/*__BUILD_FONTS__*/', fonts.map(name => JSON.stringify(name)).join(','));
        this.emitFile({ type: 'asset', fileName: 'sw.js', source });
        const typography = new URL('../shared/typography/', import.meta.url);
        for (const name of readdirSync(new URL('licenses/', typography))) {
          this.emitFile({ type: 'asset', fileName: `fonts/licenses/${name}`, source: readFileSync(new URL(`licenses/${name}`, typography)) });
        }
        this.emitFile({ type: 'asset', fileName: 'fonts/manifest.json', source: readFileSync(new URL('manifest.json', typography)) });
        this.emitFile({ type: 'asset', fileName: '_headers', source: `/*\n  Content-Security-Policy: ${csp}; frame-ancestors 'none'\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  X-Frame-Options: DENY\n  Permissions-Policy: camera=(), microphone=(), geolocation=()\n  Cache-Control: no-cache\n/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n` });
      },
    }],
  };
});
