#!/usr/bin/env node
// Dev-first bin shim (dsh style): run the CLI straight from TypeScript source.
// Publishing/bundling story is deferred to a later phase; tsx is a devDep.
import 'tsx/esm'

await import('../src/main.ts')
