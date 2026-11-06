import {NEWSLETTER_LISTS} from './newsletter-lists.mjs';
import {campaignFromParams,UNATTRIBUTED} from './measurement-core.mjs';
if(navigator.doNotTrack!=='1'&&!navigator.globalPrivacyControl){
 const event=document.querySelector('[data-sr-event]')?.dataset.srEvent;
 const q=new URLSearchParams(location.search),language=q.get('sr_lang');
 if(event==='signup_confirmation'||event==='signup_request_accepted'&&location.pathname==='/subscription/form'){
  const confirmed=event==='signup_confirmation';
  const confirmedLanguages=[...new Set(q.getAll('l').map(id=>Object.entries(NEWSLETTER_LISTS).find(([,value])=>value===id)?.[0]).filter(Boolean))];
  const confirmationPage=confirmedLanguages.length===1?`/${confirmedLanguages[0]}/newsletter/confirmed/`:'/newsletter/confirmed/';
  const page=confirmed?confirmationPage:['de','fr','it','en'].includes(language)?`/${language}/newsletter/`:'/newsletter/requested/';
  const cohort=confirmed?UNATTRIBUTED:campaignFromParams(q);
  fetch('/_measure',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({event,page,...cohort,test:q.get('sr_test')==='1'}),keepalive:true,credentials:'omit',referrerPolicy:'no-referrer'}).catch(()=>{});
 }
}
