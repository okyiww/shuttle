import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/main.ts'],
  format: ['esm'],
  dts: true,
  outDir: 'lib',
  // Keep dsh-style artifact names: lib/index.js + lib/index.d.ts.
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})
