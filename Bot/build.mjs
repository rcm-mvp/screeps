// Bundles src/main.ts into a single dist/main.js uploadable to Screeps.
// The contract import from `screeps-web-api-bridge` is type-only and erased
// here — no Node-only code (ws, zlib) ever reaches the game bundle.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2019',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
  banner: { js: `// screeps-executor — built ${new Date().toISOString()}` },
});
