// Per-session journeys from /srv/safetyradar/stats/visits (see visits.mjs).
// Usage: node deploy/analytics/report-journeys.mjs [YYYY-MM-DD|today|yesterday] [--test] [--paid] [--json]
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {day} from './report.mjs';
import {readVisits} from './visits.mjs';
const clock=ts=>new Intl.DateTimeFormat('de-CH',{timeZone:'Europe/Zurich',hour:'2-digit',minute:'2-digit',second:'2-digit'}).format(new Date(ts));
const label=c=>c.source==='unattributed'?'direct/other':`${c.source} ${c.campaign}${c.variant!=='none'?' ad '+c.variant.toUpperCase():''}`;
const isHome=p=>/^\/(de|fr|it|en)\/$/.test(p);
export function buildJourneys(rows){
 const sessions=new Map();
 for(const r of [...rows].sort((a,b)=>a.ts.localeCompare(b.ts))){
  const s=sessions.get(r.sid)??(sessions.set(r.sid,{sid:r.sid,vid:r.vid,start:r.ts,end:r.ts,entry:null,firstTouch:r.ft,returning:r.returning,device:r.device,steps:[],byPv:new Map(),signup:false}),sessions.get(r.sid));
  s.end=r.ts;
  if(r.event==='pageview'){const step={page:r.page,at:r.ts,seconds:null,depth:null};s.steps.push(step);if(r.pv)s.byPv.set(r.pv,step);if(!s.entry)s.entry={source:r.source,medium:r.medium,campaign:r.campaign,variant:r.variant};}
  else if(r.event==='engagement'){const step=r.pv&&s.byPv.get(r.pv);if(step){step.seconds=r.activeSeconds;step.depth=r.depth;}else s.steps.push({page:r.page,at:r.ts,seconds:r.activeSeconds,depth:r.depth,orphan:true});}
  else if(r.event==='signup_submission')s.signup=true;
 }
 return [...sessions.values()].map(({byPv,...s})=>{s.entry??={source:s.steps[0]?.source??'unattributed',medium:'none',campaign:'none',variant:'none'};s.pages=s.steps.filter(x=>!x.orphan).length;s.totalSeconds=s.steps.reduce((n,x)=>n+(x.seconds||0),0);s.homeBounce=s.pages===1&&isHome(s.steps[0].page);return s;});
}
export function summarize(sessions){
 const groups=new Map();
 for(const s of sessions){const k=label(s.entry);const g=groups.get(k)??(groups.set(k,{source:k,sessions:0,pages:0,seconds:0,homeBounces:0,signups:0,returning:0}),groups.get(k));g.sessions++;g.pages+=s.pages;g.seconds+=s.totalSeconds;g.homeBounces+=s.homeBounce?1:0;g.signups+=s.signup?1:0;g.returning+=s.returning?1:0;}
 const all=[...groups.values()].reduce((a,g)=>{for(const k of ['sessions','pages','seconds','homeBounces','signups','returning'])a[k]+=g[k];return a;},{source:'ALL',sessions:0,pages:0,seconds:0,homeBounces:0,signups:0,returning:0});
 const fmt=g=>({...g,avgPages:g.sessions?+(g.pages/g.sessions).toFixed(2):0,avgSeconds:g.sessions?Math.round(g.seconds/g.sessions):0,homeBouncePct:g.sessions?Math.round(100*g.homeBounces/g.sessions):0});
 return {all:fmt(all),bySource:[...groups.values()].sort((a,b)=>b.sessions-a.sessions).map(fmt)};
}
export function journeyText(date,sessions,{test=false}={}){
 const sum=summarize(sessions);
 const line=g=>`${g.source}: ${g.sessions} sessions, ${g.avgPages} pages/session, ${g.avgSeconds}s active/session, ${g.homeBouncePct}% bounced on homepage, ${g.signups} signups, ${g.returning} returning`;
 const out=[`Safety Radar visitor journeys ${date}${test?' (TEST)':''} (times Europe/Zurich)`,line(sum.all),...sum.bySource.map(g=>'  '+line(g)),''];
 for(const s of sessions){
  out.push(`${clock(s.start)}–${clock(s.end)}  ${label(s.entry)}  ${s.device}  ${s.returning?'returning':'new'} visitor  ${s.pages} pages  ${s.totalSeconds}s  signup: ${s.signup?'yes':'no'}  [v:${s.vid.slice(0,6)} s:${s.sid}]`);
  if(s.returning&&label(s.firstTouch)!==label(s.entry))out.push(`    first touch: ${label(s.firstTouch)}`);
  for(const x of s.steps)out.push(`    ${clock(x.at)}  ${x.page}  ${x.seconds??'?'}s  scroll ${x.depth??'?'}%${x.orphan?'  (no page view row)':''}`);
 }
 out.push('','Sessions end after 30 min without a beacon. Seconds = visible active time per page (5 s steps, stops after 60 s idle). "?" = the page was closed before the engagement beacon arrived. Visitors with DNT/GPC, blocked JS or blocked cookies are missing or appear as one-page visitors.');
 return out.join('\n')+'\n';
}
export function writeJourneyReport(dir,out,now=new Date()){const date=day(now);const text=journeyText(date,buildJourneys(readVisits(dir,date)));const f=path.join(out,'journeys-latest.txt');fs.writeFileSync(f+'.tmp',text);fs.renameSync(f+'.tmp',f);}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2),test=args.includes('--test'),paid=args.includes('--paid'),json=args.includes('--json');
 const arg=args.find(a=>!a.startsWith('--'))||'today';const d=new Date();if(arg==='yesterday')d.setDate(d.getDate()-1);
 const date=/^\d{4}-\d{2}-\d{2}$/.test(arg)?arg:day(d);
 const dir=process.env.VISITS_DIR||'/srv/safetyradar/stats/visits';
 let sessions=buildJourneys(readVisits(dir,date,{test}));if(paid)sessions=sessions.filter(s=>s.entry.medium==='paid_social');
 process.stdout.write(json?JSON.stringify({date,summary:summarize(sessions),sessions},null,2)+'\n':journeyText(date,sessions,{test}));
}
