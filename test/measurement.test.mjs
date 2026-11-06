import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import vm from 'node:vm';
import {campaignFromParams,campaignQuery,UNATTRIBUTED} from '../public/measurement-core.mjs';
import {NEWSLETTER_LISTS} from '../public/newsletter-lists.mjs';
import {knownPages,parseEvent,recordEvent,prune,createMeasurementServer} from '../deploy/analytics/server.mjs';
import {buildReport,writeReport,cutoff} from '../deploy/analytics/report.mjs';
const paid={source:'ig',medium:'paid_social',campaign:'de-2026-w45',variant:'b'};
const base={event:'pageview',page:'/de/',...paid,test:true};
test('only controlled Meta/newsletter cohorts survive, never arbitrary query data',()=>{
 assert.deepEqual(campaignFromParams(campaignQuery(paid)),paid);assert.deepEqual(campaignFromParams(new URLSearchParams('utm_source=fb&utm_medium=paid_social&utm_campaign=de-2026-w45&utm_content=a')),{...paid,source:'fb',variant:'a'});
 for(const params of ['utm_source=ig&utm_medium=paid_social&utm_campaign=person%40example.org&utm_content=b','utm_source={{site_source_name}}&utm_medium=paid_social&utm_campaign=de-2026-w45','email=private&token=secret'])assert.deepEqual(campaignFromParams(new URLSearchParams(params)),UNATTRIBUTED);
 assert.equal(campaignFromParams(new URLSearchParams('utm_source=newsletter&utm_medium=email&utm_campaign=2026-w45&utm_content=a')).source,'newsletter');
});
test('boundary rejects identities/unknown pages and keeps confirmations unlinked',()=>{
 const pages=knownPages();for(const bad of [{...base,email:'private'},{...base,url:'https://x/?token=private'},{...base,page:'/de/private-token/'}])assert.throws(()=>parseEvent(bad,pages));
 assert.throws(()=>parseEvent({...base,event:'engagement',activeSeconds:7,depth:100},pages));
 assert.throws(()=>parseEvent({...base,event:'signup_confirmation',page:'/newsletter/confirmed/'},pages));
 assert.equal(parseEvent({...base,...UNATTRIBUTED,event:'signup_confirmation',page:'/newsletter/confirmed/'},pages).language,'und');
});
test('aggregate storage has no raw events or identities; tests excluded and 56-day expiry enforced',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sr-measure-'));const now=new Date('2026-11-07T10:00:00Z');try{
  const e=parseEvent({...base,test:false},knownPages());recordEvent(e,dir,now);recordEvent({...e,event:'engagement',activeSeconds:15,depth:75},dir,now);recordEvent({...e,event:'signup_submission'},dir,now);recordEvent({...e,test:true},dir,now);
  let report=buildReport(dir,now);assert.equal(report.metrics.pageviews,1);assert.equal(report.metrics.activeSeconds,15);assert.equal(report.metrics.signupSubmissions,1);assert.equal(report.metrics.signupConfirmedResponses,0);assert.equal(report.byCampaign[0].source,'ig');
  fs.writeFileSync(path.join(dir,'2020-01-01.json'),'{}');fs.writeFileSync(path.join(dir,'2020-01-01.test.json.tmp'),'{}');prune(dir,now);assert.ok(!fs.existsSync(path.join(dir,'2020-01-01.json')));assert.ok(!fs.existsSync(path.join(dir,'2020-01-01.test.json.tmp')));
  assert.equal(cutoff(now),'2026-09-13');writeReport(dir,path.join(dir,'out'),now);const raw=fs.readFileSync(path.join(dir,'2026-11-07.json'),'utf8');assert.ok(!/email|token|referrer|userAgent|remote_ip|requestId|timestamp/.test(raw));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('real HTTP collector accepts safe events, separates tests and rejects wrong origins/PII',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sr-measure-http-'));const server=createMeasurementServer({dir});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}/_measure`;
 const post=(data,origin='https://safetyradar.ch',headers={})=>fetch(url,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body:JSON.stringify(data)});
 try{assert.equal((await post(base)).status,204);assert.equal((await post({...base,email:'private'})).status,400);assert.equal((await post(base,'https://other.example')).status,400);
  assert.equal((await post({...base,event:'signup_confirmation',page:'/newsletter/confirmed/',...UNATTRIBUTED},'https://news.safetyradar.ch')).status,204);
  assert.equal((await post({...base,event:'signup_confirmation',page:'/newsletter/confirmed/',...UNATTRIBUTED})).status,400);
  assert.equal((await post(base,'https://safetyradar.ch',{DNT:'1'})).status,204);
  const raw=fs.readdirSync(dir).filter(x=>x.endsWith('.json')).map(x=>fs.readFileSync(path.join(dir,x),'utf8')).join('');assert.ok(!raw.includes('private'));const total=Object.values(JSON.parse(raw).rows).reduce((n,r)=>n+r.pageviews+r.signupConfirmedResponses,0);assert.equal(total,2);assert.equal(buildReport(dir).metrics.pageviews,0);
 }finally{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
test('website client propagates cohorts, never reads email, and emits each stage once',()=>{
 const events=[],listeners={},formListeners={},links=[{href:'https://safetyradar.ch/de/newsletter/'}];let now=0,tick;
 const form={action:'https://news.safetyradar.ch/subscription/form',addEventListener:(n,f)=>formListeners[n]=f};Object.defineProperty(form,'email',{get(){throw Error('email must not be read');}});
 const document={documentElement:{lang:'de'},visibilityState:'visible',querySelectorAll:q=>q==='a[href]'?links:[form],querySelector:()=>({getBoundingClientRect:()=>({top:0,height:1000})}),addEventListener:(n,f)=>listeners[n]=f};
 const sandbox={navigator:{},location:new URL('https://safetyradar.ch/de/?utm_source=ig&utm_medium=paid_social&utm_campaign=de-2026-w45&utm_content=b&fbclid=private&sr_test=1'),URL,URLSearchParams,campaignFromParams,campaignQuery,document,performance:{now:()=>now},innerHeight:800,setInterval:f=>{tick=f;return 1;},clearInterval(){},addEventListener:(n,f)=>listeners[n]=f,fetch:(url,o)=>{events.push(JSON.parse(o.body));assert.equal(o.credentials,'omit');assert.equal(o.referrerPolicy,'no-referrer');return Promise.resolve();}};
 vm.runInNewContext(fs.readFileSync('public/measurement.js','utf8').replace(/^import .*\n/,''),sandbox);
 formListeners.submit();formListeners.submit();for(let i=0;i<12;i++){now+=1000;tick();}listeners.pagehide();listeners.visibilitychange();
 assert.deepEqual(events.map(x=>x.event),['pageview','signup_submission','engagement']);assert.equal(events[2].activeSeconds,10);assert.ok(!JSON.stringify(events).includes('private'));assert.ok(links[0].href.includes('utm_content=b'));assert.ok(form.action.includes('sr_lang=de'));
});
test('Listmonk confirmation payload never includes its subscriber URL or campaign',()=>{
 const events=[];const sandbox={navigator:{},location:{pathname:'/subscription/optin/private-uuid',search:'?token=private&l=private-list&utm_source=ig&utm_medium=paid_social&utm_campaign=de-2026-w45'},URLSearchParams,campaignFromParams,UNATTRIBUTED,NEWSLETTER_LISTS,document:{querySelector:()=>({dataset:{srEvent:'signup_confirmation'}})},fetch:(url,o)=>{events.push(JSON.parse(o.body));return Promise.resolve();}};
 vm.runInNewContext(fs.readFileSync('public/measurement-listmonk.mjs','utf8').replace(/^import .*\n/gm,''),sandbox);assert.equal(events.length,1);assert.equal(events[0].page,'/newsletter/confirmed/');assert.equal(events[0].source,'unattributed');assert.ok(!JSON.stringify(events).includes('private'));
 const template=fs.readFileSync('deploy/listmonk/overrides/static/public/templates/message.html','utf8');assert.ok(template.includes('eq .Data.Title (L.T "public.subConfirmedTitle")'));assert.ok(!template.includes('SubUUID'));
});
