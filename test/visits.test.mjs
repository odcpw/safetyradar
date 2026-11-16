import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createVisitLog,pruneVisits,readVisits,deviceClass,visitCutoff} from '../deploy/analytics/visits.mjs';
import {buildJourneys,summarize,journeyText} from '../deploy/analytics/report-journeys.mjs';
import {knownPages,parseEvent,createMeasurementServer} from '../deploy/analytics/server.mjs';
const vid='a'.repeat(32),ad={source:'ig',medium:'paid_social',campaign:'de-2026-w47',variant:'b'},none={source:'unattributed',medium:'none',campaign:'none',variant:'none'};
const ev=(o)=>({event:'pageview',page:'/de/',language:'de',category:'home',article:null,test:false,vid,...ad,...o});
test('sessions, first touch, returning visitors and engagement joined to its page view',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sr-visits-'));let t=Date.parse('2026-11-16T09:00:00Z');const clock=()=>new Date(t);try{
  let log=createVisitLog(dir,{clock});
  const a=log(ev({pv:'1'.repeat(16)}),{ua:'Mozilla (iPhone; Mobile)'});t+=40e3;
  log(ev({event:'engagement',pv:'1'.repeat(16),activeSeconds:35,depth:75}));t+=5e3;
  const b=log(ev({page:'/de/rulings/',category:'rulings',pv:'2'.repeat(16)}));
  assert.equal(a.sid,b.sid);assert.equal(a.returning,false);assert.equal(a.device,'mobile');assert.ok(!('ua' in a)&&!('ip' in a));
  t+=31*60e3;log=createVisitLog(dir,{clock});// restart: state rebuilt from disk
  const c=log(ev({...none,pv:'3'.repeat(16)}));assert.notEqual(c.sid,a.sid);assert.equal(c.returning,true);assert.deepEqual(c.ft,ad);
  t+=3*3600e3;const late=log(ev({event:'engagement',pv:'3'.repeat(16),activeSeconds:5,depth:25,...none}));assert.equal(late.sid,c.sid);
  assert.equal(log({...ev({}),vid:undefined}),null);
  const rows=readVisits(dir,'2026-11-16');assert.equal(rows.length,5);
  const s=buildJourneys(rows);assert.equal(s.length,2);assert.deepEqual(s[0].steps.map(x=>[x.page,x.seconds,x.depth]),[['/de/',35,75],['/de/rulings/',null,null]]);assert.equal(s[0].homeBounce,false);assert.equal(s[1].homeBounce,true);
  const sum=summarize(s);assert.equal(sum.all.sessions,2);assert.equal(sum.all.homeBouncePct,50);
  const text=journeyText('2026-11-16',s);assert.match(text,/ig de-2026-w47 ad B/);assert.match(text,/returning visitor/);assert.match(text,/first touch: ig de-2026-w47 ad B/);
  fs.writeFileSync(path.join(dir,'2026-01-01.jsonl'),'');pruneVisits(dir,clock());assert.ok(!fs.existsSync(path.join(dir,'2026-01-01.jsonl')));assert.equal(visitCutoff(clock()),'2026-08-19');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('collector validates visitor ids and keeps aggregates working',async()=>{
 const pages=knownPages(),base={event:'pageview',page:'/de/',...ad,test:true};
 assert.throws(()=>parseEvent({...base,vid:'person@example.org'},pages));assert.throws(()=>parseEvent({...base,pv:'xyz'},pages));
 assert.equal(parseEvent({...base,vid,pv:'f'.repeat(16)},pages).vid,vid);assert.equal('vid' in parseEvent(base,pages),false);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sr-visits-http-'));const visits=createVisitLog(path.join(dir,'visits'));const server=createMeasurementServer({dir,visits});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const r=await fetch(`http://127.0.0.1:${server.address().port}/_measure`,{method:'POST',headers:{Origin:'https://safetyradar.ch','Content-Type':'application/json','User-Agent':'Mozilla/5.0 (Windows NT 10.0)'},body:JSON.stringify({...base,vid,pv:'f'.repeat(16)})});assert.equal(r.status,204);
  const files=fs.readdirSync(path.join(dir,'visits'));assert.equal(files.length,1);assert.match(files[0],/\.test\.jsonl$/);const row=JSON.parse(fs.readFileSync(path.join(dir,'visits',files[0]),'utf8'));assert.equal(row.device,'desktop');assert.ok(!/Windows|127\.0\.0\.1/.test(JSON.stringify(row)));
  assert.ok(fs.readdirSync(dir).some(f=>f.endsWith('.test.json')));
 }finally{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
test('device class is coarse',()=>{assert.equal(deviceClass('Mozilla/5.0 (iPad; CPU OS 17)'),'tablet');assert.equal(deviceClass(''),'desktop');});
