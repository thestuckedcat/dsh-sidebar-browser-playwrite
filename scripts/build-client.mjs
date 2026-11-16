import { build } from 'esbuild'
import { readFileSync } from 'node:fs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
await build({
  entryPoints: ['src/sidebar-client.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  format: 'cjs',
  external: ['react'],
  banner: { js: 'window.__ModuleLoader__.load({id:' + JSON.stringify(manifest.name) + ',factory(require){\nconst module={exports:{}};' },
  footer: { js: 'return module.exports;\n}});' },
})
