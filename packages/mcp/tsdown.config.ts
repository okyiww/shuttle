import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  outDir: 'lib',
  // The SDK is a real runtime dependency and stays external (it is listed in
  // package.json dependencies; everything else must not be bundled either).
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
})
