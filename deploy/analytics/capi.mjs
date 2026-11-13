// Server-side Meta Conversions API for ad-click visitors only. No pixel, no cookies, no browser storage.
// Only visits that arrived with Meta's fbclid (sent by the page as fbc) are reported. IP and user agent
// are used for the single outgoing request and never written to disk. Counters and sanitised errors only.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {day,cutoff} from './report.mjs';
export const GRAPH='https://graph.facebook.com/v21.0';
export const FBC_RE=/^fb\.1\.\d{13}\.[A-Za-z0-9_-]{8,500}$/;
export const ENGAGED_SECONDS=20;
// EngagedVisit counts on the homepage and on single accident/ruling pages.
export function engagedPage(e){return e.category==='home'||(['accidents','rulings'].includes(e.category)&&!!e.article);}
export function capiEventFor(e){
 if(!e.fbc)return null;
 if(e.event==='engagement'&&engagedPage(e)&&(e.activeSeconds>=ENGAGED_SECONDS||e.depth>=100))return 'EngagedVisit';
 if(e.event==='signup_submission')return 'Lead';
 return null;
}
// One event per ad click and type: Meta also deduplicates on event_name + event_id.
export const eventId=(name,fbc)=>crypto.createHash('sha256').update(name+':'+fbc.split('.').slice(3).join('.')).digest('hex').slice(0,32);
export function clientIp(req){const xff=String(req.headers['x-forwarded-for']||'').split(',').map(s=>s.trim()).filter(Boolean);return xff.at(-1)||req.socket?.remoteAddress||undefined;}
export function buildPayload({name,e,ip,ua,now=Date.now()}){
 const user_data={fbc:e.fbc};if(ip)user_data.client_ip_address=ip;if(ua)user_data.client_user_agent=String(ua).slice(0,512);
 return {event_name:name,event_time:Math.floor(now/1000),event_id:eventId(name,e.fbc),action_source:'website',event_source_url:'https://safetyradar.ch'+e.page,user_data,
  custom_data:name==='EngagedVisit'?{content_category:e.category,active_seconds:e.activeSeconds,scroll_depth:e.depth}:{content_category:e.category}};
}
const clean=s=>String(s??'').replace(/access_token=[^&\s]+/gi,'access_token=[redacted]').replace(/https?:\/\/\S+/g,'[url]').slice(0,200);
export function recordCapi(dir,{name,ok,test,error},now=new Date()){
 fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,day(now)+'.json');
 let data;try{data=JSON.parse(fs.readFileSync(file,'utf8'));}catch{data={day:day(now),sent:{},failed:{},test:{},errors:[]};}
 const bucket=ok?(test?'test':'sent'):'failed';data[bucket][name]=(data[bucket][name]||0)+1;
 if(!ok&&error){data.errors.push({at:now.toISOString(),event:name,test:!!test,status:error.status??null,code:error.code??null,message:clean(error.message),fbtrace_id:error.fbtrace_id??null});data.errors=data.errors.slice(-20);}
 const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(data)+'\n');fs.renameSync(temp,file);
}
export function pruneCapi(dir,now=new Date()){if(!fs.existsSync(dir))return;for(const f of fs.readdirSync(dir))if(/^\d{4}-\d{2}-\d{2}\.json(?:\.tmp)?$/.test(f)&&f.slice(0,10)<cutoff(now))fs.unlinkSync(path.join(dir,f));}
export function loadCapiConfig(env=process.env){
 const dataset=env.CAPI_DATASET_ID,credDir=env.CREDENTIALS_DIRECTORY;
 if(!dataset||!/^\d{6,20}$/.test(dataset)||!credDir)return null;
 let token;try{token=fs.readFileSync(path.join(credDir,'meta_token'),'utf8').trim();}catch{return null;}
 const testCode=env.CAPI_TEST_EVENT_CODE&&/^[A-Za-z0-9_-]{3,40}$/.test(env.CAPI_TEST_EVENT_CODE)?env.CAPI_TEST_EVENT_CODE:null;
 return token?{dataset,token,testCode}:null;
}
export function createCapiSender({config,dir,fetchImpl=fetch,timeoutMs=3000}){
 const seen=new Map(),TTL=48*3600e3;
 return function maybeSend(e,req){
  if(!config)return null;const name=capiEventFor(e);if(!name)return null;
  // Browser tests (sr_test=1) only reach Meta as Test Events, and only while a test code is configured.
  if(e.test&&!config.testCode)return null;
  const payload=buildPayload({name,e,ip:clientIp(req),ua:req.headers['user-agent']});
  const now=Date.now();for(const[k,t]of seen)if(now-t>TTL)seen.delete(k);
  const key=(e.test?'t:':'')+payload.event_id;if(seen.has(key))return null;if(seen.size>=20000)seen.delete(seen.keys().next().value);seen.set(key,now);
  const body=new URLSearchParams({data:JSON.stringify([payload]),access_token:config.token});if(e.test)body.set('test_event_code',config.testCode);
  return fetchImpl(`${GRAPH}/${config.dataset}/events`,{method:'POST',body,signal:AbortSignal.timeout(timeoutMs)})
   .then(async r=>{const j=await r.json().catch(()=>({}));if(!r.ok||!j.events_received)throw Object.assign(new Error(j.error?.message||'no events_received'),{status:r.status,code:j.error?.code,fbtrace_id:j.error?.fbtrace_id||j.fbtrace_id});recordCapi(dir,{name,ok:true,test:e.test});return {name,ok:true};})
   .catch(err=>{seen.delete(key);try{recordCapi(dir,{name,ok:false,test:e.test,error:{status:err.status,code:err.code,message:err.name==='TimeoutError'?'timeout':err.message,fbtrace_id:err.fbtrace_id}});}catch{}return {name,ok:false};});
 };
}
