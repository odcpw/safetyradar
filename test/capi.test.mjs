import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';
import {campaignFromParams,campaignQuery} from '../public/measurement-core.mjs';
import {knownPages,parseEvent,createMeasurementServer} from '../deploy/analytics/server.mjs';
import {capiEventFor,createCapiSender,eventId,loadCapiConfig,FBC_RE} from '../deploy/analytics/capi.mjs';
const FBC='fb.1.1763000000000.IwAR0abcDEF_ghi-123';
const paid={source:'fb',medium:'paid_social',campaign:'de-2026-w46',variant:'b'};
const pages=knownPages();
const ev=(x)=>parseEvent({event:'engagement',page:'/de/',...paid,test:false,activeSeconds:0,depth:0,...x},pages);
test('fbc is validated at the boundary and only allowed on engagement and signup submissions',()=>{
 assert.equal(ev({fbc:FBC}).fbc,FBC);
 for(const bad of ['fb.1.123.x','fb.1.1763000000000.has space','fb.1.1763000000000.https://x/?a=b',42])assert.throws(()=>ev({fbc:bad}));
 assert.throws(()=>parseEvent({event:'pageview',page:'/de/',...paid,test:false,fbc:FBC},pages));
 assert.ok(FBC_RE.test(FBC));
});
test('EngagedVisit needs fbc and >=20 s or full scroll on home or a case page; Lead needs fbc',()=>{
 assert.equal(capiEventFor(ev({activeSeconds:20})),null);
 assert.equal(capiEventFor(ev({activeSeconds:15,fbc:FBC})),null);
 assert.equal(capiEventFor(ev({activeSeconds:20,fbc:FBC})),'EngagedVisit');
 assert.equal(capiEventFor(ev({depth:100,fbc:FBC})),'EngagedVisit');
 assert.equal(capiEventFor(ev({page:'/de/privacy/',activeSeconds:60,fbc:FBC})),null);
 const rid=JSON.parse(fs.readFileSync('data/rulings.json'))[0].id;
 assert.equal(capiEventFor(ev({page:`/de/rulings/${rid}/`,activeSeconds:25,fbc:FBC})),'EngagedVisit');
 assert.equal(capiEventFor(parseEvent({event:'signup_submission',page:'/de/',...paid,test:false,fbc:FBC},pages)),'Lead');
 assert.equal(capiEventFor(parseEvent({event:'signup_submission',page:'/de/',...paid,test:false},pages)),null);
});
test('config reads the token only from the systemd credential and keeps test code separate',()=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'sr-cred-'));try{
  assert.equal(loadCapiConfig({CAPI_DATASET_ID:'1455663602556769'}),null);
  fs.writeFileSync(path.join(d,'meta_token'),'TOKENVALUE\n');
  assert.deepEqual(loadCapiConfig({CAPI_DATASET_ID:'1455663602556769',CREDENTIALS_DIRECTORY:d}),{dataset:'1455663602556769',token:'TOKENVALUE',testCode:null});
  assert.equal(loadCapiConfig({CAPI_DATASET_ID:'1455663602556769',CREDENTIALS_DIRECTORY:d,CAPI_TEST_EVENT_CODE:'TEST123'}).testCode,'TEST123');
 }finally{fs.rmSync(d,{recursive:true,force:true});}
});
test('HTTP collector sends one deduplicated CAPI event per click, never stores fbc/IP/UA, and test visits stay test-only',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sr-capi-'));const calls=[];
 const fakeFetch=async(url,o)=>{calls.push({url,body:Object.fromEntries(o.body)});return {ok:true,status:200,json:async()=>({events_received:1})};};
 const config={dataset:'1455663602556769',token:'SECRET',testCode:null};
 const sender=createCapiSender({config,dir:path.join(dir,'capi'),fetchImpl:fakeFetch});
 const server=createMeasurementServer({dir,capi:sender});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}/_measure`;
 const post=(data)=>fetch(url,{method:'POST',headers:{Origin:'https://safetyradar.ch','Content-Type':'application/json','User-Agent':'Mozilla/5.0 TestBrowser','X-Forwarded-For':'198.51.100.7'},body:JSON.stringify(data)});
 const base={event:'engagement',page:'/de/',...paid,test:false,activeSeconds:30,depth:50};
 try{
  assert.equal((await post({...base,fbc:FBC})).status,204);
  assert.equal((await post({...base,fbc:FBC})).status,204);
  assert.equal((await post({...base})).status,204);
  assert.equal((await post({...base,test:true,fbc:FBC})).status,204);
  assert.equal((await post({event:'signup_submission',page:'/de/',...paid,test:false,fbc:FBC})).status,204);
  await new Promise(r=>setTimeout(r,50));
  assert.equal(calls.length,2);
  const [engaged,lead]=calls.map(c=>JSON.parse(c.body.data)[0]);
  assert.equal(engaged.event_name,'EngagedVisit');assert.equal(lead.event_name,'Lead');
  assert.equal(engaged.action_source,'website');assert.equal(engaged.event_source_url,'https://safetyradar.ch/de/');
  assert.deepEqual(engaged.user_data,{fbc:FBC,client_ip_address:'198.51.100.7',client_user_agent:'Mozilla/5.0 TestBrowser'});
  assert.equal(engaged.event_id,eventId('EngagedVisit',FBC));assert.equal(eventId('EngagedVisit','fb.1.1999999999999.IwAR0abcDEF_ghi-123'),engaged.event_id);
  assert.ok(!('test_event_code' in calls[0].body));assert.ok(!calls[0].url.includes('SECRET'));
  const stored=fs.readdirSync(dir,{recursive:true}).filter(f=>f.endsWith('.json')).map(f=>fs.readFileSync(path.join(dir,f),'utf8')).join('');
  for(const leak of ['IwAR0abc','198.51.100.7','TestBrowser','SECRET'])assert.ok(!stored.includes(leak),leak);
  const capiDay=JSON.parse(fs.readFileSync(path.join(dir,'capi',fs.readdirSync(path.join(dir,'capi'))[0])));
  assert.deepEqual(capiDay.sent,{EngagedVisit:1,Lead:1});
 }finally{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
test('test events go to Meta only with test_event_code; failures are counted without token or URL',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sr-capi-t-'));const calls=[];
 const fail=async(url,o)=>{calls.push(Object.fromEntries(o.body));return {ok:false,status:400,json:async()=>({error:{message:'Invalid parameter access_token=SECRET https://graph.facebook.com/x',code:100,fbtrace_id:'Ftrace'}})};};
 const send=createCapiSender({config:{dataset:'1',token:'SECRET',testCode:'TEST99'},dir,fetchImpl:fail});
 try{
  const r=await send(ev({test:true,activeSeconds:20,fbc:FBC}),{headers:{'user-agent':'UA'},socket:{}});
  assert.equal(r.ok,false);assert.equal(calls[0].test_event_code,'TEST99');
  const raw=fs.readFileSync(path.join(dir,fs.readdirSync(dir)[0]),'utf8');assert.ok(!raw.includes('SECRET'));assert.ok(!raw.includes('graph.facebook'));
  const j=JSON.parse(raw);assert.equal(j.failed.EngagedVisit,1);assert.equal(j.errors[0].code,100);assert.equal(j.errors[0].fbtrace_id,'Ftrace');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('website client sends fbc only when fbclid is present and never stores it',()=>{
 const run=(href)=>{const events=[],listeners={},formListeners={},links=[{href:'https://safetyradar.ch/de/newsletter/'}];let now=0,tick;
  const form={action:'https://news.safetyradar.ch/subscription/form',addEventListener:(n,f)=>formListeners[n]=f};
  const document={documentElement:{lang:'de'},visibilityState:'visible',querySelectorAll:q=>q==='a[href]'?links:[form],querySelector:()=>({getBoundingClientRect:()=>({top:0,height:1000})}),addEventListener:(n,f)=>listeners[n]=f};
  const sandbox={navigator:{},location:new URL(href),URL,URLSearchParams,campaignFromParams,campaignQuery,document,performance:{now:()=>now},innerHeight:800,setInterval:f=>{tick=f;return 1;},clearInterval(){},addEventListener:(n,f)=>listeners[n]=f,fetch:(u,o)=>{events.push(JSON.parse(o.body));return Promise.resolve();}};
  vm.runInNewContext(fs.readFileSync('public/measurement.js','utf8').replace(/^import .*\n/,''),sandbox);
  formListeners.submit();for(let i=0;i<25;i++){now+=1000;tick();}listeners.pagehide();return {events,links,form};};
 const ad=run('https://safetyradar.ch/de/?utm_source=fb&utm_medium=paid_social&utm_campaign=de-2026-w46&utm_content=b&fbclid=IwAR0abcDEF_ghi-123');
 assert.equal(ad.events[0].fbc,undefined);assert.match(ad.events[1].fbc,/^fb\.1\.\d{13}\.IwAR0abcDEF_ghi-123$/);assert.match(ad.events[2].fbc,/^fb\.1\.\d{13}\.IwAR0abcDEF_ghi-123$/);
 assert.ok(ad.links[0].href.includes('fbclid=IwAR0abcDEF_ghi-123'));assert.ok(!ad.form.action.includes('fbclid'));
 const plain=run('https://safetyradar.ch/de/');assert.ok(plain.events.every(e=>!('fbc' in e)));assert.ok(!plain.links[0].href.includes('fbclid'));
 const src=fs.readFileSync('public/measurement.js','utf8');assert.ok(!/localStorage|sessionStorage|document\.cookie/.test(src));
});
