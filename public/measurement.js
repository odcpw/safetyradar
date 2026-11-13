import {campaignFromParams,campaignQuery} from './measurement-core.mjs';
function start(){
 if(navigator.doNotTrack==='1'||navigator.globalPrivacyControl)return;
 const url=new URL(location.href),cohort=campaignFromParams(url.searchParams),test=url.searchParams.get('sr_test')==='1';
 const context={page:location.pathname,...cohort,test};
 // Meta ad click ID: read from the URL, kept in memory for this page view only, never stored.
 const fbclid=url.searchParams.get('fbclid'),fbc=fbclid&&/^[A-Za-z0-9_-]{8,500}$/.test(fbclid)?'fb.1.'+Date.now()+'.'+fbclid:null;
 const ad=fbc?{fbc}:{};
 const send=(event,extra={})=>fetch('/_measure',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...context,event,...extra}),keepalive:true,credentials:'omit',referrerPolicy:'no-referrer'}).catch(()=>{});
 send('pageview');
 // Carry campaign cohorts (and a Meta ad click ID, if the visit came from an ad) through internal links.
 document.querySelectorAll('a[href]').forEach(a=>{const to=new URL(a.href,location.href);if(to.origin!==location.origin||!/^\/(de|fr|it|en)\//.test(to.pathname))return;for(const [k,v]of campaignQuery(cohort))to.searchParams.set(k,v);if(test)to.searchParams.set('sr_test','1');if(fbc)to.searchParams.set('fbclid',fbclid);a.href=to.href;});
 document.querySelectorAll('form.nl').forEach(form=>{
  const action=new URL(form.action);if(action.origin!=='https://news.safetyradar.ch')return;
  for(const[k,v]of campaignQuery(cohort))action.searchParams.set(k,v);
  action.searchParams.set('sr_lang',document.documentElement.lang);if(test)action.searchParams.set('sr_test','1');form.action=action.href;
  let submitted=false;form.addEventListener('submit',()=>{if(!submitted){submitted=true;send('signup_submission',ad);}});
 });
 let activeMs=0,last=performance.now(),lastAction=last,finished=false,depth=0;
 const tick=()=>{const now=performance.now();if(document.visibilityState==='visible'&&now-lastAction<60000)activeMs+=Math.min(now-last,1000);last=now;
  const main=document.querySelector('main');if(main){const r=main.getBoundingClientRect();depth=Math.max(depth,Math.min(100,Math.max(0,Math.floor((innerHeight-r.top)/Math.max(r.height,1)*4)*25)));}};
 for(const event of ['pointerdown','keydown','scroll'])addEventListener(event,()=>{lastAction=performance.now();},{passive:true});
 const timer=setInterval(tick,1000);tick();
 const finish=()=>{if(finished)return;tick();finished=true;clearInterval(timer);send('engagement',{activeSeconds:Math.min(1800,Math.floor(activeMs/5000)*5),depth,...ad});};
 addEventListener('pagehide',finish);document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')finish();});
}
start();
