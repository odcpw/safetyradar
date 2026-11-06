// Minimal OpenAI client (fetch only, no deps). Two endpoints:
//   decide()  -> POST /v1/decisions  (gpt-6-luna; predicate/choice/score answers; input-only billing)
//   extract() -> POST /v1/responses  (structured output via JSON schema)
// Per-run hard caps (env): LLM_MAX_CALLS (300), LLM_MAX_TOKENS (1_000_000), LLM_MAX_USD (0.50).
// Every attempt/result/error is fsynced to data/llm-requests.jsonl before continuation; flush() also writes a run summary. No keys or source content are journaled.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const ROOT = new URL('../../', import.meta.url);
const USAGE_FILE = new URL('data/llm-usage.jsonl', ROOT);
// USD per 1M tokens, standard tier, short context. Verified 2026-10-27:
// https://developers.openai.com/api/docs/pricing , https://developers.openai.com/api/docs/guides/decisions
export const PRICES = {
  'decisions:gpt-6-luna': { in: 0.10, cached: 0.01, write: 0.125, out: 0 },
  'gpt-6-luna':    { in: 0.10, cached: 0.01, write: 0.125, out: 0.50 },

};
const USD_CHF = Number(process.env.LLM_USD_CHF || 0.80);
const CAPS = { calls: Number(process.env.LLM_MAX_CALLS || 300), tokens: Number(process.env.LLM_MAX_TOKENS || 1_000_000), usd: Number(process.env.LLM_MAX_USD || 0.5) };
export const DEFAULT_MODEL = process.env.LLM_MODEL || 'gpt-6-luna';
export function assertAllowedModel(model) { if(model!=='gpt-6-luna')throw new Error('Only gpt-6-luna is permitted; refusing '+model); }
const JOURNAL=process.env.LLM_JOURNAL_FILE || new URL('data/llm-requests.jsonl',ROOT);
const runId=randomUUID();
export function journal(event) { const fd=fs.openSync(JOURNAL,'a');try{fs.writeSync(fd,JSON.stringify({at:new Date().toISOString(),runId,script:process.argv[1]?.split('/').pop(),...event})+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);} }

export class LlmUnavailable extends Error {}
export class LlmCapReached extends Error {}

const run = { script: process.argv[1]?.split('/').pop(), start: new Date().toISOString(), calls: 0, errors: 0, input: 0, cached: 0, output: 0, usd: 0, byModel: {} };
export const usage = () => ({ ...run, chf: +(run.usd * USD_CHF).toFixed(5) });
export const available = () => !!process.env.OPENAI_API_KEY;

function cost(key, u) {
  const p = PRICES[key]; if(!p)throw new Error('Unapproved model price: '+key);
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

async function post(path, body) {
  assertAllowedModel(body.model);
  for(const key of ['LLM_MODEL','LLM_AUDIT_MODEL','LLM_VERIFY_MODEL','LLM_VERIFY_REVIEW_MODEL','LLM_DRAFT_MODEL'])if(process.env[key])assertAllowedModel(process.env[key]);
  if (!available()) throw new LlmUnavailable('OPENAI_API_KEY not set');
  checkCaps();run.calls++;
  const requestId=randomUUID(), key=path==='decisions'?'decisions:gpt-6-luna':body.model;
  const meta={requestId,model:body.model,endpoint:'/v1/'+path,attempt:1};
  journal({...meta,event:'started'});
  let res;
  try {res=await fetch('https://api.openai.com/v1/'+path,{method:'POST',body:JSON.stringify(body),signal:AbortSignal.timeout(120000),headers:{Authorization:`Bearer ${process.env.OPENAI_API_KEY}`,'Content-Type':'application/json'}});}
  catch(e){run.errors++;journal({...meta,event:'transport_error',errorType:e.name,usageKnown:false});throw e;}
  if(!res.ok){run.errors++;journal({...meta,event:'http_error',status:res.status,usageKnown:false});await res.body?.cancel();const msg=path+' HTTP '+res.status;if([401,403].includes(res.status))throw new LlmUnavailable(msg);throw new Error(msg);}
  let j;try{j=await res.json();}catch(e){run.errors++;journal({...meta,event:'response_parse_error',usageKnown:false});throw e;}
  account(key,j.usage||{});
  journal({...meta,event:'response',providerResponseId:j.id||null,usageKnown:!!j.usage,usage:j.usage||null,estimatedUsd:cost(key,j.usage||{})});
  return j;
}

/** Decisions API. questions: [{type:'predicate'|'choice'|'score', name, instructions, choices?|levels?}] -> {name: answer} */
export async function decide({ input, questions }) {
  const j = await post('decisions', { model: 'gpt-6-luna', input, questions });

  return Object.fromEntries((j.answers || []).map(a => [a.name, a]));
}

/** Responses API with strict JSON schema. Returns parsed object. */
export async function extract({ system, input, schema, name = 'result', model = DEFAULT_MODEL, effort }) {
  assertAllowedModel(model);
  const body = { model, reasoning:{effort:'high'}, input: [{ role: 'developer', content: system }, { role: 'user', content: input }],
    text: { format: { type: 'json_schema', name, strict: true, schema } } };

  const j = await post('responses', body);

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
