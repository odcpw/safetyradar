// Prices (USD per 1M tokens, standard tier, short context ≤272K) – verified 2026-10-28 on
// https://developers.openai.com/api/docs/pricing . Unknown models are refused so the cap can't be bypassed silently.
export const PRICES: Record<string, { in: number; cached: number; write: number; out: number }> = {
	"gpt-6-luna": { in: 0.1, cached: 0.01, write: 0.125, out: 0.5 },
};
type U = { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } };
/** pi-ai reports `input` without cached tokens; price every bucket and take the higher of ours and pi-ai's own figure. */
export function usdFor(modelKey: string, u: U): number {
	const id = modelKey.split("/").pop()!;
	const p = PRICES[id];
 if (!p) throw new Error("Unapproved reviewer cost model");
	const ours = ((u.input ?? 0) * p.in + (u.cacheRead ?? 0) * p.cached + (u.cacheWrite ?? 0) * p.write + (u.output ?? 0) * p.out) / 1e6;
	return Math.max(ours, u.cost?.total ?? 0);
}
export function totalUsd(state: { models: Record<string, U>; tools: Record<string, U> }): number {
	let t = 0;
	for (const [k, u] of Object.entries(state.models ?? {})) t += usdFor(k, u);
	for (const u of Object.values(state.tools ?? {})) t += u.cost?.total ?? 0;
	return t;
}
