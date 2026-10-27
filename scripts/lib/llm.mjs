// Minimal OpenAI client (fetch only, no deps). Two endpoints:
//   decide()  -> POST /v1/decisions  (gpt-6-luna; predicate/choice/score answers; input-only billing)
//   extract() -> POST /v1/responses  (structured output via JSON schema)
// Per-run hard caps (env): LLM_MAX_CALLS (300), LLM_MAX_TOKENS (1_000_000), LLM_MAX_USD (0.50).
// Usage is appended to data/llm-usage.jsonl on flush(). The API key is read from process.env only and never logged.
import fs from 'node:fs';

const ROOT = new URL('../../', import.meta.url);
const USAGE_FILE = new URL('data/llm-usage.jsonl', ROOT);
// USD per 1M tokens, standard tier, short context. Verified 2026-10-27:
// https://developers.openai.com/api/docs/pricing , https://developers.openai.com/api/docs/guides/decisions
export const PRICES = {
  'decisions:gpt-6-luna': { in: 0.10, cached: 0.01, write: 0.125, out: 0 },
  'gpt-6-luna':    { in: 0.10, cached: 0.01, write: 0.125, out: 0.50 },
  'gpt-6.1-terra': { in: 1.00, cached: 0.05, write: 1.25, out: 5.00 },
  'gpt-6.1-sol':   { in: 2.00, cached: 0.10, write: 2.50, out: 10.00 },
};
const USD_CHF = Number(process.env.LLM_USD_CHF || 0.80);
const CAPS = { calls: Number(process.env.LLM_MAX_CALLS || 300), tokens: Number(process.env.LLM_MAX_TOKENS || 1_000_000), usd: Number(process.env.LLM_MAX_USD || 0.5) };
export const DEFAULT_MODEL = process.env.LLM_MODEL || 'gpt-6-luna';

export class LlmUnavailable extends Error {}
export class LlmCapReached extends Error {}

const run = { script: process.argv[1]?.split('/').pop(), start: new Date().toISOString(), calls: 0, errors: 0, input: 0, cached: 0, output: 0, usd: 0, byModel: {} };
export const usage = () => ({ ...run, chf: +(run.usd * USD_CHF).toFixed(5) });
export const available = () => !!process.env.OPENAI_API_KEY;

function cost(key, u) {
  const p = PRICES[key] || PRICES['gpt-6.1-sol'];
  const cached = u.input_tokens_details?.cached_tokens || 0, write = u.input_tokens_details?.cache_write_tokens || 0;
  const fresh = (u.input_tokens || 0) - cached - write;
  return (fresh * p.in + cached * p.cached + write * p.write + (u.output_tokens || 0) * p.out) / 1e6;
}
function account(key, u = {}) {
  const usd = cost(key, u);
  run.input += u.input_tokens || 0; run.cached += u.input_tokens_details?.cached_tokens || 0; run.output += u.output_tokens || 0; run.usd += usd;
  const m = (run.byModel[key] ||= { calls: 0, input: 0, output: 0, usd: 0 });
  m.calls++; m.input += u.input_tokens || 0; m.output += u.output_tokens || 0; m.usd += usd;
}
function checkCaps() {
  if (run.calls >= CAPS.calls) throw new LlmCapReached(`call cap ${CAPS.calls} reached`);
  if (run.input + run.output >= CAPS.tokens) throw new LlmCapReached(`token cap ${CAPS.tokens} reached`);
  if (run.usd >= CAPS.usd) throw new LlmCapReached(`cost cap $${CAPS.usd} reached`);
}

async function post(path, body, tries = 4) {
  if (!available()) throw new LlmUnavailable('OPENAI_API_KEY not set');
  checkCaps();
  run.calls++;
  for (let i = 0; ; i++) {
    let res;
    try {
      res = await fetch('https://api.openai.com/v1/' + path, {
        method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(180000),
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      });
    } catch (e) { res = null; if (i >= tries - 1) { run.errors++; throw e; } }
    if (res?.ok) return await res.json();
    if (res) {
      const msg = `${path} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
      if ([401, 403].includes(res.status)) { run.errors++; throw new LlmUnavailable(msg); }
      if (![408, 409, 429].includes(res.status) && res.status < 500 || i >= tries - 1) { run.errors++; throw new Error(msg); }
    }
    await new Promise(r => setTimeout(r, 1000 * 2 ** i + Math.random() * 500));
  }
}

/** Decisions API. questions: [{type:'predicate'|'choice'|'score', name, instructions, choices?|levels?}] -> {name: answer} */
export async function decide({ input, questions }) {
  const j = await post('decisions', { model: 'gpt-6-luna', input, questions });
  account('decisions:gpt-6-luna', j.usage);
  return Object.fromEntries((j.answers || []).map(a => [a.name, a]));
}

/** Responses API with strict JSON schema. Returns parsed object. */
export async function extract({ system, input, schema, name = 'result', model = DEFAULT_MODEL, effort }) {
  const body = { model, input: [{ role: 'developer', content: system }, { role: 'user', content: input }],
    text: { format: { type: 'json_schema', name, strict: true, schema } } };
  if (effort) body.reasoning = { effort };
  const j = await post('responses', body);
  account(model, j.usage);
  const msg = (j.output || []).find(o => o.type === 'message');
  const txt = msg?.content?.find(c => c.type === 'output_text')?.text;
  if (!txt) throw new Error(`no output_text (status ${j.status})`);
  return JSON.parse(txt);
}

export function flush(extra = {}) {
  if (!run.calls) return usage();
  const u = { ...usage(), end: new Date().toISOString(), ...extra };
  fs.appendFileSync(USAGE_FILE, JSON.stringify(u) + '\n');
  console.log(`LLM usage: ${u.calls} calls, ${u.input} in / ${u.output} out tokens, ≈ USD ${u.usd.toFixed(4)} (CHF ${u.chf.toFixed(4)})`);
  return u;
}

// Stable cache key per item.
import { createHash } from 'node:crypto';
export const hash = s => createHash('sha1').update(String(s)).digest('hex').slice(0, 12);
