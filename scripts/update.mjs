#!/usr/bin/env node
// One command: fetch + filter + draft (into data/queue.json) + rebuild the static site.
import { execSync } from 'node:child_process';
const run = c => { console.log(`\n$ ${c}`); execSync(c, { stdio: 'inherit' }); };
run('node scripts/fetch-sources.mjs');
run('node scripts/fetch-jobs.mjs');
run('node scripts/queue-report.mjs');
run('npm run build');
