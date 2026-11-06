#!/usr/bin/env node
// Operator-only, real-source regression eval. Never writes published data or the verification ledger.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { sourceDocuments } from './lib/source-documents.mjs';
import { verifyContent } from './lib/verify-content.mjs';
import { lessonFromRefs } from './lib/lesson-refs.mjs';
import { readLedger, reviewKey } from './lib/content-integrity.mjs';
import { available, flush } from './lib/llm.mjs';
const root=path.resolve(process.argv.find(a=>a.startsWith('--root='))?.slice(7)||'.');
if(!process.argv.includes('--run')||!available())throw Error('Explicit --run and OPENAI_API_KEY required; read-only source eval only');
const catalog=JSON.parse(fs.readFileSync(path.join(root,'data/lesson-refs.json')));
const ledger=readLedger(root);
const cases=[
 {kind:'rulings',id:'2026-07-03-bger-7b-1323-2024',name:'Fräse eventualiter is not conviction',mutate:e=>{const a=e.defendants.flatMap(d=>d.allegations).find(a=>a.status==='alternative_charge'&&a.articles.some(x=>x.code==='UVG'));assert.ok(a,'source-audited alternative UVG charge required');a.status='convicted';}},
 {kind:'rulings',id:'2026-05-26-be-og-bk-25-485-bagger',name:'Bern article cannot transfer from foreman to injured worker',mutate:e=>{const d=e.defendants.find(d=>/arbeiter|arbeitnehmer/i.test(d.role.de)&&!/polier/i.test(d.role.de));assert.ok(d?.allegations?.length,'source-audited worker required');d.allegations[0].articles.push({code:'StGB',article:'125',paragraph:'2',letter:null});}},
 {kind:'rulings',id:'2026-08-19-bger-6b-784-2025-ag-dachplatte',name:'Rejected indictment argument is not remand rationale',mutate:e=>{e.why={de:'Das Bundesgericht hob den Freispruch wegen Verletzung des Anklageprinzips auf.',fr:"Le Tribunal fédéral a annulé l’acquittement en raison d’une violation du principe de l’accusation.",it:"Il Tribunale federale ha annullato l’assoluzione per violazione del principio accusatorio.",en:'The Federal Supreme Court overturned the acquittal because the indictment principle was violated.'};}},
 {kind:'accidents',id:'2026-09-24-bl-reinach-labor',name:'Fourth examined person is not fourth injured',mutate:e=>{e.casualties={fatal:0,injured:4,checked:0};}},
 {kind:'accidents',id:'2026-03-16-fr-le-mouret-poteau',name:'Nonfatal English electrocution fails deterministically',mutate:e=>{e.title.en='Worker electrocuted during power-line maintenance';}},
 {kind:'accidents',id:'2026-09-02-vs-le-chable-grue',name:'Installation does not support maintenance reference',mutate:e=>{e.lesson=lessonFromRefs(catalog,['vuv-art43-maintenance']);}},
];
const results=[];
for(const c of cases){
 try{
  const entry=JSON.parse(fs.readFileSync(path.join(root,'data',c.kind+'.json'))).find(e=>e.id===c.id);
  assert.ok(entry,'live record exists');assert.equal(ledger[reviewKey(c.kind,c.id)]?.state,'verified','baseline must be source-audited, not legacy');
  const {sources}=await sourceDocuments(entry);
  const publicationEvidence=c.kind==='rulings'?{published:entry.published,publishedSource:entry.publishedSource,status:'preserved-existing-provenance-not-reaudited'}:null;
  const baseline=await verifyContent({entry,kind:c.kind,sources,catalog,publicationEvidence});
  assert.equal(baseline.state,'verified','real baseline must pass before evaluating mutation: '+baseline.issues?.join('; '));
  const bad=structuredClone(entry);c.mutate(bad);
  const rejected=await verifyContent({entry:bad,kind:c.kind,sources,catalog,publicationEvidence});
  assert.equal(rejected.state,'held','observed factual defect must be blocked');
  results.push({id:c.id,name:c.name,passed:true,baseline,rejected});console.log('PASS '+c.name);
 }catch(e){results.push({id:c.id,name:c.name,passed:false,issue:e.message});console.log('FAIL '+c.name+': '+e.message);}
}
fs.mkdirSync(path.join(root,'editorial/evals'),{recursive:true});
fs.writeFileSync(path.join(root,'editorial/evals/observed-regressions.json'),JSON.stringify(results,null,1)+'\n');
flush({script:'prove-content-gates',passed:results.filter(r=>r.passed).length,total:cases.length});
if(results.some(r=>!r.passed))process.exitCode=1;
