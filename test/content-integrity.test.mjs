import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fingerprint, structuralErrors, evidenceErrors, gateCollection, ledgerErrors, validDate } from '../scripts/lib/content-integrity.mjs';
import { verifyContent, sourceParagraphs } from '../scripts/lib/verify-content.mjs';
import { allegationText, publicCaseStatus } from '../scripts/lib/legal-display.mjs';
import { applyFeedback } from '../scripts/lib/review-feedback.mjs';
const L = s => ({de:s,fr:s,it:s,en:s});
const article = (code, number) => ({code,article:number,paragraph:null,letter:null});
const base = {id:'case',accidentDate:null,judgmentDate:null,caseStatus:'resolved',outcome:'serious',lesson:null,title:L('Workplace injury'),facts:{what:L('A workplace injury'),injuries:L('Hand injury')},defendants:[{id:'d1',role:L('Trainer'),verdict:'convicted',allegations:[{status:'convicted',offence:L('Negligent injury'),articles:[article('StGB','125')]},{status:'alternative_charge',offence:L('Accident Insurance Act offence'),articles:[article('UVG','112')]}],sanction:null,sanctionHistory:[]}]};
const source={url:'https://example.org/decision',text:'The trainer was convicted of negligent injury under Art. 125 StGB. Art. 112 UVG was charged only in the alternative.'};
const evidence=[0,1].map(j=>({path:`/defendants/0/allegations/${j}`,personId:'d1',sourcePerson:'A (trainer)',section:'Facts A/B',sourceUrl:source.url,sourceHash:fingerprint(source.text),quotes:[source.text]}));
test('Fräse: conviction and eventualiter remain separately labelled, including Fedlex article text',()=>{
 const d=base.defendants[0];const text=d.allegations.map(a=>allegationText(a,'de',s=>s)).join('; ');
 assert.match(text,/convicted: Negligent injury \(Art\. 125 StGB\)/);
 assert.match(text,/alternative_charge: Accident Insurance Act offence \(Art\. 112 UVG\)/);
 assert.deepEqual(structuralErrors(base,'rulings'),[]);
});
test('Bern excavator: another person cannot reuse the foreman’s article evidence',()=>{
 const e=structuredClone(base);e.defendants.push({...e.defendants[0],id:'d2',role:L('Injured worker'),verdict:'dismissed',allegations:[{status:'dismissed',offence:L('UVG allegation'),articles:[]}]});
 assert.ok(evidenceErrors(e,'rulings',evidence).some(x=>x.includes('d2')));
 const copied=[...evidence,{...evidence[0],path:'/defendants/1/allegations/0'}];
 assert.ok(evidenceErrors(e,'rulings',copied).some(x=>x.includes('d2')));
});
test('open case cannot display a current conviction sanction; contested orders are explicitly historical',()=>{
 const e=structuredClone(base);e.caseStatus='remanded';e.defendants[0].verdict='open';e.defendants[0].allegations=[];e.defendants[0].sanction={dailyUnits:120};
 assert.ok(structuralErrors(e,'rulings').some(x=>x.includes('current sanction')));
 e.defendants[0].sanction=null;e.defendants[0].sanctionHistory=[{stage:'contested_penalty_order',date:null,sanction:{dailyUnits:120}}];
 assert.deepEqual(structuralErrors(e,'rulings'),[]);
});
test('nonfatal English electrocution and conflicting casualty counts fail deterministically',()=>{
 const e={id:'shock',accidentDate:null,outcome:'injured',title:L('Worker electrocuted'),facts:{}};
 assert.ok(structuralErrors(e,'accidents').length);
 e.title=L('Worker suffers electric shock');assert.deepEqual(structuralErrors(e,'accidents'),[]);
 assert.ok(structuralErrors({...e,casualties:{fatal:1,injured:0,checked:0}},'accidents').length);
 assert.deepEqual(structuralErrors({...e,casualties:{fatal:0,injured:3,checked:1}},'accidents'),[]);
});
test('source unavailable, uncertainty and API errors preserve old data and exclude new records',async()=>{
 const before=[{id:'old',value:'reviewed'}], candidates=[{id:'old',value:'unsupported'},{id:'new'}];
 for(const verify of [async()=>({state:'held',issues:['source unavailable']}),async()=>{throw Error('API unavailable');}]){
  const held=[];const result=await gateCollection({kind:'accidents',before,candidates,verify,onHold:h=>held.push(h)});
  assert.deepEqual(result.accepted,before);assert.equal(held.length,2);
 }
});
test('missing independent answers cannot approve a record, even when extractor approves',async()=>{
 const result=await verifyContent({kind:'accidents',entry:{id:'one',accidentDate:null,outcome:'injured'},sources:[source],extractor:async()=>({status:'supported',issues:[],evidence:['facts','outcomes','dates'].map(topic=>({path:'/facts',topic,sourceIndex:0,paragraphIds:[0],personId:null,sourcePerson:null,section:'report'}))}),decider:async()=>({facts:{choice:'supported'}})});
 assert.equal(result.state,'held');assert.ok(result.issues.some(x=>x.includes('outcomes')));
});
test('forged or out-of-range paragraph IDs cannot become verified evidence',async()=>{
 const result=await verifyContent({kind:'accidents',entry:{id:'one',accidentDate:null,outcome:'injured'},sources:[source],extractor:async()=>({status:'supported',issues:[],evidence:['facts','outcomes','dates'].map(topic=>({path:'/facts',topic,sourceIndex:0,paragraphIds:[999],personId:null,sourcePerson:null,section:'report'}))}),decider:async()=>{throw Error('must not reach semantic approval');}});
 assert.equal(result.state,'held');assert.ok(result.issues.some(x=>x.includes('evidence')));
});
test('changed/new unreviewed records block publication; unchanged legacy is explicitly not verified',()=>{
 const entry={id:'legacy',value:1},ledger={'accidents/legacy':{state:'legacy_unreviewed',hash:fingerprint(entry)}};
 assert.deepEqual(ledgerErrors('.', {accidents:[entry]},ledger),[]);
 assert.ok(ledgerErrors('.',{accidents:[{...entry,value:2}]},ledger).length);
 assert.ok(ledgerErrors('.',{accidents:[{id:'new'}]},ledger).length);
});
test('rejected deletion keeps the original reviewed record',async()=>{
 const before=[{id:'keep'}];const result=await gateCollection({kind:'rulings',before,candidates:[],verify:async()=>{throw Error('unexpected');}});
 assert.deepEqual(result.accepted,before);
});
test('held source cannot be marked published or rejected by an agent summary',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sr-held-'));
 try{fs.writeFileSync(path.join(dir,'queue.json'),JSON.stringify([{url:'https://example.org/new',title:'New'}]));fs.writeFileSync(path.join(dir,'accidents.json'),'[]');
 applyFeedback(dir,{added:[{file:'accidents.json',id:'new',source:'https://example.org/new'}],skipped:[{url:'https://example.org/new',reason:'uncertain'}]}, {},'2026-11-06',{heldUrls:['https://example.org/new']});
 assert.equal(JSON.parse(fs.readFileSync(path.join(dir,'queue.json')))[0].status,'held');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('partial dates retain precision; invalid calendar days fail',()=>{
 for(const d of ['2019','2019-01','2019-01-17'])assert.equal(validDate(d),true);
 for(const d of ['2019-02-29','2026-13','2026-01-32'])assert.equal(validDate(d),false);
});

test('real published-data validator exits nonzero for an ungated edit',async()=>{
 const {spawnSync}=await import('node:child_process');const root=fs.mkdtempSync(path.join(os.tmpdir(),'sr-publish-'));
 try{
  fs.mkdirSync(path.join(root,'data'));fs.mkdirSync(path.join(root,'editorial'));
  const ledger={};
  for(const kind of ['accidents','rulings']){
   const items=JSON.parse(fs.readFileSync(new URL(`../data/${kind}.json`,import.meta.url)));
   fs.writeFileSync(path.join(root,'data',kind+'.json'),JSON.stringify(items));
   for(const e of items)ledger[`${kind}/${e.id}`]={state:'legacy_unreviewed',hash:fingerprint(e)};
  }
  for(const f of ['jobs.json','lesson-refs.json'])fs.copyFileSync(new URL('../data/'+f,import.meta.url),path.join(root,'data',f));
  fs.writeFileSync(path.join(root,'editorial/review-ledger.json'),JSON.stringify(ledger));
  const run=()=>spawnSync(process.execPath,['scripts/validate-data.mjs',path.join(root,'data')],{encoding:'utf8'});
  assert.equal(run().status,0);
  const file=path.join(root,'data/accidents.json'),items=JSON.parse(fs.readFileSync(file));items[0].title.en='An unsupported edit';fs.writeFileSync(file,JSON.stringify(items));
  const result=run();assert.equal(result.status,1);assert.match(result.stderr,/missing or stale review/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('source evidence must explicitly cover dates, not merely facts and outcomes',async()=>{
 const result=await verifyContent({kind:'accidents',entry:{id:'one',accidentDate:null,outcome:'injured'},sources:[source],extractor:async()=>({status:'supported',issues:[],evidence:['facts','outcomes'].map(topic=>({path:'/facts',topic,sourceIndex:0,paragraphIds:[0],personId:null,sourcePerson:null,section:'report'}))}),decider:async()=>{throw Error('must not bypass missing date evidence');}});
 assert.equal(result.state,'held');assert.ok(result.issues.includes('missing dates evidence'));
});

test('every attached lesson needs separate source-bound activity and prerequisites, not just a hazard match',()=>{
 const entry={lesson:{refs:[{id:'vuv-art43-maintenance'}]}};
 const generic=[{...evidence[0],personId:null,sourcePerson:null,topic:'lessons',path:'/lesson'}];
 assert.equal(evidenceErrors(entry,'accidents',generic).length,2);
 const specific=['activity','prerequisites'].map(part=>({...generic[0],path:'/lesson/refs/0/'+part}));
 assert.deepEqual(evidenceErrors(entry,'accidents',specific),[]);
});

test('all curated references have explicit activity/prerequisite thresholds',async()=>{
 const {LESSON_REQUIREMENTS}=await import('../scripts/lib/lesson-applicability.mjs');
 const catalog=JSON.parse(fs.readFileSync(new URL('../data/lesson-refs.json',import.meta.url)));
 for(const r of catalog)assert.ok(LESSON_REQUIREMENTS[r.id],r.id);
});

test('long minified court/news text is segmented without dropping source material',()=>{
 const source=('Art. 125 concerns the first defendant. The other person faced a separate allegation. ').repeat(100);
 const parts=sourceParagraphs(source);assert.ok(parts.length>1);
 assert.ok(parts.every(p=>p.text.length<=1200));assert.equal(parts.map(p=>p.text).join(' ').replace(/\s+/g,' ').trim(),source.replace(/\s+/g,' ').trim());
});

test('resolved proceedings do not imply an established final judgment',()=>{
 assert.equal(publicCaseStatus({caseStatus:'resolved',final:null}),null);
 assert.equal(publicCaseStatus({caseStatus:'resolved',final:false}),null);
 assert.equal(publicCaseStatus({caseStatus:'resolved',final:true}),'resolved');
 assert.equal(publicCaseStatus({caseStatus:'remanded',final:true}),'remanded');
});
test('concrete independent-review issues hold even if all dimension flags say supported',async()=>{
 const result=await verifyContent({kind:'accidents',entry:{id:'one',accidentDate:null,outcome:'injured'},sources:[source],extractor:async()=>({status:'supported',issues:[],evidence:['facts','outcomes','dates'].map(topic=>({path:'/facts',topic,sourceIndex:0,paragraphIds:[0],personId:null,sourcePerson:null,section:'report'}))}),decider:async()=>({...Object.fromEntries(['facts','outcomes','dates','legal','sanctions','lessons'].map(k=>[k,{choice:'supported'}])),issues:[{path:'/facts/what',reason:'unsupported claim'}]})});
 assert.equal(result.state,'held');assert.ok(result.issues.some(i=>i.includes('unsupported claim')));
});
