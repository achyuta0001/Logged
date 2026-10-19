// Build config. Two things on top of Vite's defaults:
//  - maplibre-gl gets a chunk of its own, so its ~1 MB stays cached across deploys that only change
//    the app (the city overview needs it plus the small entry chunk; the pincode view is a separate
//    chunk that src/boot.ts loads with import()).
//  - `logged:sw` writes the service worker (src/sw.js) to <base>sw.js with this build's id and file
//    list, and stamps the same id into index.html (<meta name="logged-build">).
import { defineConfig, type Plugin } from 'vite';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** every file under `dir`, as sorted '/'-separated paths relative to it */
function walk(dir: string, prefix = ''): string[] {
  return readdirSync(join(dir, prefix), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? walk(dir, `${prefix}${e.name}/`) : e.isFile() ? [`${prefix}${e.name}`] : []))
    .sort();
}

function serviceWorker(): Plugin {
  let publicDir = '';
  return {
    name: 'logged:sw',
    apply: 'build',
    enforce: 'post',
    configResolved(c) {
      publicDir = c.publicDir;
    },
    generateBundle(_opts, bundle) {
      const files = Object.values(bundle)
        .filter((f) => !f.fileName.endsWith('.map') && !f.fileName.startsWith('.vite/'))
        .sort((a, b) => (a.fileName < b.fileName ? -1 : 1));
      const pub = publicDir && existsSync(publicDir) ? walk(publicDir) : [];
      // the build id covers code and data: a deploy that only rebuilt packs is a new worker too, so a
      // cache keyed by it never serves one build's packs to another build's page
      const h = createHash('sha256');
      for (const f of files) h.update(`${f.fileName}\0`).update(f.type === 'chunk' ? f.code : f.source);
      for (const p of pub) h.update(`${p}\0`).update(readFileSync(join(publicDir, p)));
      const build = h.digest('hex').slice(0, 12);
      const html = bundle['index.html'];
      if (!html || html.type !== 'asset') throw new Error('logged:sw: index.html is not in the bundle');
      html.source = String(html.source).replace('</head>', `  <meta name="logged-build" content="${build}" />\n  </head>`);
      const shell = [...files.map((f) => f.fileName), ...pub.filter((p) => p === 'manifest.webmanifest' || p.startsWith('icons/'))];
      const data = ['data/pins/index.json', 'data/city/city.geojson'].filter((p) => pub.includes(p));
      const sw = readFileSync(new URL('./src/sw.js', import.meta.url), 'utf8')
        .replace("/* @build */ 'dev'", JSON.stringify(build))
        .replace('/* @shell */ []', JSON.stringify(shell))
        .replace('/* @data */ []', JSON.stringify(data));
      if (/\/\* @(build|shell|data) \*\//.test(sw)) throw new Error('logged:sw: src/sw.js placeholders not filled');
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: sw });
    },
  };
}

export default defineConfig({
  build: {
    // the maplibre-gl chunk is one prebuilt library (~1.03 MB, its own worker inlined) that cannot be
    // split further; every app chunk is far below this
    chunkSizeWarningLimit: 1100,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [{ name: 'maplibre', test: /node_modules[\\/]maplibre-gl[\\/]/ }],
        },
      },
    },
  },
  plugins: [serviceWorker()],
});
