import http from 'node:http';import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
import {campaignFromParams,pageDimensions} from '../../public/measurement-core.mjs';
import {day,cutoff,empty,writeReport} from './report.mjs';
const ROOT=fileURLToPath(new URL('../../',import.meta.url));
export function knownPages(root=ROOT){const pages=new Set(['/newsletter/confirmed/','/newsletter/requested/']);for(const lang of ['de','fr','it','en']){for(const suffix of ['','accidents/','rulings/','jobs/','newsletter/','newsletter/confirmed/','privacy/','jobs/post/'])pages.add(`/${lang}/${suffix}`);for(const kind of ['accidents','rulings','jobs'])for(const e of JSON.parse(fs.readFileSync(path.join(root,'data',kind+'.json'))))pages.add(`/${lang}/${kind}/${e.id}/`);}return pages;}
export function parseEvent(input,pages){
 if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!['event','page','source','medium','campaign','variant','activeSeconds','depth','test'].includes(k)))throw Error('invalid fields');
 if(!['pageview','engagement','signup_submission','signup_request_accepted','signup_confirmation'].includes(input.event)||!pages.has(input.page)||typeof input.test!=='boolean')throw Error('invalid event');
 const confirm=input.event==='signup_confirmation',confirmationPage=/^\/(?:(de|fr|it|en)\/)?newsletter\/confirmed\/$/.test(input.page);if(confirm&&!confirmationPage||!confirm&&confirmationPage)throw Error('invalid confirmation page');
 if(input.event==='engagement'&&(!Number.isInteger(input.activeSeconds)||input.activeSeconds<0||input.activeSeconds>1800||input.activeSeconds%5||![0,25,50,75,100].includes(input.depth)))throw Error('invalid engagement');
 const q=new URLSearchParams({utm_source:input.source,utm_medium:input.medium,utm_campaign:input.campaign,utm_content:input.variant});const cohort=campaignFromParams(q);
 if(confirm&&cohort.source!=='unattributed')throw Error('confirmations cannot be joined to campaigns');
 return {event:input.event,page:input.page,...cohort,...pageDimensions(input.page),test:input.test,activeSeconds:input.event==='engagement'?input.activeSeconds:0,depth:input.event==='engagement'?input.depth:0};
}
export function recordEvent(event,dir,now=new Date()){
 fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,day(now)+(event.test?'.test':'')+'.json');const data=fs.existsSync(file)?JSON.parse(fs.readFileSync(file)):{day:day(now),rows:{}};
 const key=JSON.stringify([event.page,event.source,event.medium,event.campaign,event.variant]);if(!data.rows[key]&&Object.keys(data.rows).length>=5000)throw Error('daily cohort limit');
 const r=data.rows[key]??={page:event.page,language:event.language,category:event.category,article:event.article,source:event.source,medium:event.medium,campaign:event.campaign,variant:event.variant,...empty()};
 const metric={pageview:'pageviews',signup_submission:'signupSubmissions',signup_request_accepted:'signupAcceptedResponses',signup_confirmation:'signupConfirmedResponses'}[event.event];
 if(metric)r[metric]++;else{r.engagementSamples++;r.activeSeconds+=event.activeSeconds;for(const depth of [25,50,75,100])if(event.depth>=depth)r['depth'+depth]++;}
 const temp=file+'.tmp';fs.writeFileSync(temp,JSON.stringify(data)+'\n');fs.renameSync(temp,file);
}
export function prune(dir,now=new Date()){if(!fs.existsSync(dir))return;for(const f of fs.readdirSync(dir))if(/^\d{4}-\d{2}-\d{2}(\.test)?\.json(?:\.tmp)?$/.test(f)&&f.slice(0,10)<cutoff(now))fs.unlinkSync(path.join(dir,f));}
export function createMeasurementServer({dir,root=ROOT}={}){
 let pages=knownPages(root),refreshed=Date.now(),minute=0,requests=0;
 return http.createServer(async(req,res)=>{res.setHeader('Cache-Control','no-store');
  if(req.url==='/_measure/health'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');return;}
  if(req.url!=='/_measure'||req.method!=='POST'){res.writeHead(404);res.end();return;}
  if(!['https://safetyradar.ch','https://news.safetyradar.ch'].includes(req.headers.origin)||!/^application\/json(?:;|$)/i.test(req.headers['content-type']||'')){res.writeHead(400);res.end();return;}
  if(req.headers.dnt==='1'||req.headers['sec-gpc']==='1'){res.writeHead(204);res.end();return;}
  const nowMinute=Math.floor(Date.now()/60000);if(nowMinute!==minute){minute=nowMinute;requests=0;}if(++requests>1000){res.writeHead(429);res.end();return;}
  try{let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>2048){res.writeHead(413);res.end();return;}}
   if(Date.now()-refreshed>60000){pages=knownPages(root);refreshed=Date.now();}
   const e=parseEvent(JSON.parse(body),pages);
   const site=req.headers.origin==='https://safetyradar.ch';if(site&&['signup_confirmation','signup_request_accepted'].includes(e.event)||!site&&!['signup_confirmation','signup_request_accepted'].includes(e.event))throw Error('wrong event origin');
   if(!e.test&&/bot|crawl|spider|slurp|curl|wget|python|httpx|go-http|headless|preview|monitor/i.test(req.headers['user-agent']||'')){res.writeHead(204);res.end();return;}
   recordEvent(e,dir);res.writeHead(204);res.end();
  }catch{res.writeHead(400);res.end();}
 });
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const dir=process.env.MEASUREMENT_DIR||'/srv/safetyradar/stats/events',out=path.dirname(dir);fs.mkdirSync(dir,{recursive:true});
 const refresh=()=>{prune(dir);writeReport(dir,out);};refresh();setInterval(refresh,60000).unref();
 createMeasurementServer({dir}).listen(Number(process.env.MEASUREMENT_PORT||9112),'127.0.0.1');
}
