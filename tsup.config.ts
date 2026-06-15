import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/ingest.ts'],
  format: ['esm'],
  splitting: false,
  clean: false,
  bundle: true,
  platform: 'node',
  target: 'node22',
  outExtension: () => ({ js: '.mjs' }),
  external: ['node:sqlite'],
  noExternal: [/@[\w-]+\/[\w-]+/, 'cac'],
})
