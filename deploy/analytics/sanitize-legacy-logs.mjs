// Run once after switching Caddy to safetyradar-pages.log, so old access files are closed.
import fs from 'node:fs';import path from 'node:path';import zlib from 'node:zlib';
import {knownPages} from './server.mjs';import {campaignFromParams} from '../../public/measurement-core.mjs';
const dir=process.env.LOG_DIR||'/var/log/caddy',pages=knownPages();let files=0,rows=0;
for(const name of fs.readdirSync(dir).filter(f=>/^safetyradar-access.*\.log(?:\.gz)?$/.test(f))){
 const file=path.join(dir,name),st=fs.statSync(file);let bytes=fs.readFileSync(file);if(name.endsWith('.gz'))bytes=zlib.gunzipSync(bytes);
 const lines=[];for(const line of bytes.toString().split('\n')){if(!line.trim())continue;let e;try{e=JSON.parse(line);}catch{continue;}const r=e.request||{},u=new URL(r.uri||e.page||'/','https://safetyradar.ch');
  const safe={ts:e.ts,request:{method:['GET','POST','HEAD','OPTIONS'].includes(r.method)?r.method:'OTHER',host:'safetyradar.ch'},status:e.status,size:e.size,duration:e.duration,bot:e.bot==='1'||e.bot===1?'1':'0',page:pages.has(u.pathname)?u.pathname:'',cohort:e.cohort||campaignFromParams(u.searchParams)};
  lines.push(JSON.stringify(safe));rows++;
 }
 let out=Buffer.from(lines.join('\n')+'\n');if(name.endsWith('.gz'))out=zlib.gzipSync(out);fs.writeFileSync(file,out);fs.utimesSync(file,st.atime,st.mtime);files++;
}
console.log(`Sanitized ${files} closed IP-free legacy access logs (${rows} rows); no raw URI/referrer retained`);
