// Controlled, cohort-only tags. No arbitrary URL/query values enter measurement storage.
export const UNATTRIBUTED={source:'unattributed',medium:'none',campaign:'none',variant:'none'};
export function campaignFromParams(q){
 const source=({facebook:'fb',instagram:'ig'})[q.get('utm_source')]||q.get('utm_source');
 const campaign=q.get('utm_campaign')||'',variant=q.get('utm_content')||'none';
 const week='20\\d{2}-w(?:0[1-9]|[1-4]\\d|5[0-3])';
 const paid=['fb','ig'].includes(source)&&q.get('utm_medium')==='paid_social'&&new RegExp('^(?:de|fr|it|en)-'+week+'$').test(campaign);
 const email=source==='newsletter'&&q.get('utm_medium')==='email'&&new RegExp('^'+week+'$').test(campaign);
 return (paid||email)&&['a','b','c','none'].includes(variant)?{source,medium:paid?'paid_social':'email',campaign,variant}:{...UNATTRIBUTED};
}
export function campaignQuery(c){const q=new URLSearchParams();if(c.source!=='unattributed'){q.set('utm_source',c.source);q.set('utm_medium',c.medium);q.set('utm_campaign',c.campaign);if(c.variant!=='none')q.set('utm_content',c.variant);}return q;}
export function pageDimensions(page){
 if(['/newsletter/confirmed/','/newsletter/requested/'].includes(page))return {language:'und',category:'newsletter',article:null};
 const m=/^\/(de|fr|it|en)\/(.*)$/.exec(page);if(!m)return null;
 const p=m[2].split('/').filter(Boolean);return {language:m[1],category:p[0]||'home',article:['accidents','rulings','jobs'].includes(p[0])&&p[1]&&p[1]!=='post'?p[1]:null};
}
