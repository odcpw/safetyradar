#!/usr/bin/env node
// One command: fetch news/rulings + jobs, LLM-label the queues, draft rulings, write review lists, rebuild the site.
// LLM steps are optional: without OPENAI_API_KEY or on API failure they are skipped with a warning.
import { execSync } from 'node:child_process';
const run = c => { console.log(`\n$ ${c}`); execSync(c, { stdio: 'inherit' }); };
const soft = c => { try { run(c); } catch (e) { console.warn(`WARNING: "${c}" failed (${e.status ?? e.message}); continuing without it.`); } };
run('node scripts/fetch-sources.mjs');
run('node scripts/fetch-jobs.mjs');
if (!process.env.OPENAI_API_KEY) console.warn('WARNING: OPENAI_API_KEY not set – skipping LLM classify/draft steps.');
else { soft('node scripts/classify.mjs'); soft('node scripts/classify-jobs.mjs'); soft('node scripts/draft-rulings.mjs'); }
run('node scripts/queue-report.mjs');
run('npm run build');
