import fs from 'node:fs';import path from 'node:path';
export const day=d=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Zurich'}).format(d);
export function cutoff(now=new Date()){const d=new Date(day(now)+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-55);return d.toISOString().slice(0,10);}
export const METRICS=['pageviews','engagementSamples','activeSeconds','depth25','depth50','depth75','depth100','signupSubmissions','signupAcceptedResponses','signupConfirmedResponses'];
export const empty=()=>Object.fromEntries(METRICS.map(k=>[k,0]));
function sum(target,row){for(const k of METRICS)target[k]+=(row[k]||0);}
export function buildReport(dir,now=new Date()){
 const rows=[];if(fs.existsSync(dir))for(const f of fs.readdirSync(dir).filter(f=>/^\d{4}-\d{2}-\d{2}\.json$/.test(f)&&f.slice(0,10)>=cutoff(now)&&f.slice(0,10)<=day(now))){const data=JSON.parse(fs.readFileSync(path.join(dir,f)));for(const row of Object.values(data.rows||{}))rows.push(row);}
 const total=empty(),campaigns=new Map(),pages=new Map(),languages=new Map(),categories=new Map();
 for(const r of rows){sum(total,r);for(const [map,key]of [[campaigns,JSON.stringify([r.source,r.medium,r.campaign,r.variant])],[pages,r.page],[languages,r.language],[categories,r.category]]){if(!map.has(key))map.set(key,{...r,...empty()});sum(map.get(key),r);}}
 const sorted=map=>[...map.values()].sort((a,b)=>b.pageviews-a.pageviews);
 return {from:cutoff(now),through:day(now),retentionDays:56,metrics:total,byCampaign:sorted(campaigns).map(({source,medium,campaign,variant,...rest})=>({source,medium,campaign,variant,...Object.fromEntries(METRICS.map(k=>[k,rest[k]]))})),byLanguage:sorted(languages).map(r=>({language:r.language,...Object.fromEntries(METRICS.map(k=>[k,r[k]]))})),byCategory:sorted(categories).map(r=>({category:r.category,...Object.fromEntries(METRICS.map(k=>[k,r[k]]))})),topPages:sorted(pages).slice(0,30).map(r=>({page:r.page,language:r.language,category:r.category,article:r.article,...Object.fromEntries(METRICS.map(k=>[k,r[k]]))})),limits:['Browser observations, not unique people, sessions or Meta clicks. JS/bot blockers and early exits cause losses.','Active visible time stops after 60 seconds idle and is sampled once at first hide/leave; rounded to 5 seconds, capped at 30 minutes. Scroll depth is viewport reach, not proof of reading.','Submissions, accepted request responses and confirmed responses are separate stages; never sum them as conversions. Repeat accepted requests are not new subscribers.','Confirmed responses are unlinked overall counts, not attributable to an earlier ad, browser or email address.','Test files excluded. No cookies, IPs, raw URLs, referrers, emails, tokens or reader IDs stored.']};
}
function atomic(file,text){const temp=file+'.tmp-'+process.pid;fs.writeFileSync(temp,text);fs.renameSync(temp,file);}
export function writeReport(dir,out,now=new Date()){
 const r=buildReport(dir,now);fs.mkdirSync(out,{recursive:true});atomic(path.join(out,'analytics-latest.json'),JSON.stringify(r,null,2)+'\n');
 const lines=[`Safety Radar aggregate measurement: ${r.from}–${r.through} (Europe/Zurich)`,...Object.entries(r.metrics).map(([k,v])=>`${k}: ${v}`),'','Campaign cohorts (views / submissions / accepted / confirmed):',...r.byCampaign.map(x=>`${x.source} ${x.campaign} ${x.variant}: ${x.pageviews} / ${x.signupSubmissions} / ${x.signupAcceptedResponses} / ${x.signupConfirmedResponses}`),'','Top pages:',...r.topPages.map(x=>`${x.pageviews} ${x.page} (${x.activeSeconds}s active across ${x.engagementSamples} samples)`),'',...r.limits];
 atomic(path.join(out,'analytics-latest.txt'),lines.join('\n')+'\n');return r;
}
