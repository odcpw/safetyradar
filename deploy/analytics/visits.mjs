// Per-visitor journeys (owner-approved 16 November 2026). The site sets one first-party cookie, sr_vid,
// holding a random ID (no PII, 90-day lifetime, never refreshed). This module stores one raw row per
// beacon in /srv/safetyradar/stats/visits/YYYY-MM-DD.jsonl for 90 days. Sessions (new after 30 min
// without a beacon) and the visitor's first-touch cohort are assigned here, on the server.
// Never stored: IP address, user agent (only a mobile/tablet/desktop class), referrer, URL query, email.
import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';
import {day} from './report.mjs';
export const VID_RE=/^[a-f0-9]{32}$/,PV_RE=/^[a-f0-9]{16}$/;
export const SESSION_GAP_MS=30*60e3,RETENTION_DAYS=90,DAILY_ROW_CAP=50000;
const FILE_RE=/^(\d{4}-\d{2}-\d{2})(\.test)?\.jsonl$/;
export function deviceClass(ua){ua=String(ua||'');return /iPad|Tablet|Kindle|Silk/i.test(ua)?'tablet':/Mobi|Android|iPhone|iPod/i.test(ua)?'mobile':'desktop';}
export function visitCutoff(now=new Date()){const d=new Date(day(now)+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-(RETENTION_DAYS-1));return d.toISOString().slice(0,10);}
export function pruneVisits(dir,now=new Date()){if(!fs.existsSync(dir))return;const c=visitCutoff(now);for(const f of fs.readdirSync(dir)){const m=/^(\d{4}-\d{2}-\d{2})/.exec(f);if(m&&m[1]<c&&/\.jsonl(?:\.tmp)?$/.test(f))fs.unlinkSync(path.join(dir,f));}}
export function readVisits(dir,date,{test=false}={}){const file=path.join(dir,date+(test?'.test':'')+'.jsonl');if(!fs.existsSync(file))return [];return fs.readFileSync(file,'utf8').split('\n').filter(Boolean).flatMap(l=>{try{return [JSON.parse(l)];}catch{return [];}});}
const cohort=e=>({source:e.source,medium:e.medium,campaign:e.campaign,variant:e.variant});
export function createVisitLog(dir,{clock=()=>new Date()}={}){
 fs.mkdirSync(dir,{recursive:true});
 const visitors=new Map(),views=new Map(),counts=new Map();
 const key=(test,vid)=>(test?'t:':'')+vid;
 // firstSid = the visitor's first session; any later session is a returning visit.
 const apply=(row,test)=>{const k=key(test,row.vid),v=visitors.get(k),t=Date.parse(row.ts);
  if(!v)visitors.set(k,{ft:row.ft||cohort(row),firstSid:row.sid,sid:row.sid,last:t});else if(t>=v.last){v.sid=row.sid;v.last=t;}
  if(row.pv&&row.event==='pageview')views.set(key(test,row.pv),{sid:row.sid,t});};
 // Rebuild visitor state from retained files so restarts keep sessions, first touch and "returning".
 const c=visitCutoff(clock());for(const f of fs.readdirSync(dir).sort()){const m=FILE_RE.exec(f);if(!m||m[1]<c)continue;const rows=readVisits(dir,m[1],{test:!!m[2]});counts.set(f,rows.length);for(const r of rows)if(VID_RE.test(r.vid||''))apply(r,!!m[2]);}
 function record(e,{ua}={}){
  if(!e.vid||!VID_RE.test(e.vid))return null;
  const now=clock(),t=now.getTime(),test=!!e.test,file=day(now)+(test?'.test':'')+'.jsonl';
  if((counts.get(file)||0)>=DAILY_ROW_CAP)return null;
  for(const[k,x]of views)if(t-x.t>24*3600e3)views.delete(k);else break;
  const v=visitors.get(key(test,e.vid)),view=e.pv&&e.event!=='pageview'?views.get(key(test,e.pv)):null;
  // Engagement/signup beacons belong to the session of their page view, even after a long hidden tab.
  const sid=view?view.sid:v&&t-v.last<SESSION_GAP_MS?v.sid:crypto.randomBytes(6).toString('hex');
  const row={ts:now.toISOString(),vid:e.vid,sid,...(e.pv?{pv:e.pv}:{}),event:e.event,page:e.page,lang:e.language,category:e.category,article:e.article,...cohort(e),device:deviceClass(ua),
   ...(e.event==='engagement'?{activeSeconds:e.activeSeconds,depth:e.depth}:{}),ft:v?v.ft:cohort(e),returning:!!v&&v.firstSid!==sid};
  apply(row,test);
  fs.appendFileSync(path.join(dir,file),JSON.stringify(row)+'\n');counts.set(file,(counts.get(file)||0)+1);
  return row;
  }
 // Drop in-memory state for visitors not seen within the retention window.
 record.forget=(now=clock())=>{const limit=now.getTime()-RETENTION_DAYS*86400e3;for(const[k,v]of visitors)if(v.last<limit)visitors.delete(k);for(const f of counts.keys())if(f.slice(0,10)<day(now))counts.delete(f);};
 return record;
}
