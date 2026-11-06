import { LEGAL_STATUSES, CASE_STATUSES, HISTORY_STAGES, REMAND_SCOPES } from './content-integrity.mjs';
export const obj = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
export const nul = s => ({ anyOf: [s, { type: 'null' }] });
export const L = obj(Object.fromEntries(['de', 'fr', 'it', 'en'].map(l => [l, { type: 'string' }])));
export const SANCTION = obj({ dailyUnits: nul({ type: 'integer' }), dailyAmount: nul({ type: 'number' }), suspended: nul({ type: 'boolean' }), probationYears: nul({ type: 'integer' }), fineCHF: nul({ type: 'number' }), custodial: nul(L), costs: nul(L), compensation: nul(L), bail: nul(L), other: nul(L) });
export const ALLEGATION = obj({ status: { type: 'string', enum: LEGAL_STATUSES }, offence: L, articles: { type: 'array', items: obj({ code: { type: 'string', enum: ['StGB', 'UVG', 'BauAV', 'VUV', 'ArG'] }, article: { type: 'string' }, paragraph: nul({ type: 'string' }), letter: nul({ type: 'string' }) }) } });
export const HISTORY = obj({ stage: { type: 'string', enum: HISTORY_STAGES }, date: nul({ type: 'string' }), sanction: SANCTION });
export const DEFENDANT = obj({ id: { type: 'string', description: 'Stable role id d1, d2 etc. Never reuse another defendant’s mapping.' }, role: L, allegations: { type: 'array', items: ALLEGATION }, verdict: { type: 'string', enum: ['convicted', 'acquitted', 'dismissed', 'open'] }, reasoning: nul(L), sanction: nul(SANCTION), sanctionHistory: { type: 'array', items: HISTORY }, short: nul(L) });
export const CASE_STATUS = { type: 'string', enum: CASE_STATUSES };

export const REMAND_SCOPE = nul({type:'string',enum:REMAND_SCOPES});
