#!/usr/bin/env node
// Stage 2: the daily editorial reviewer. A Pi Durable agent edits data/accidents.json, rulings.json and jobs.json in a
// separate detached git worktree; the host then validates and builds and commits. GIT_PUSH=1 (GitHub Pages mode): worktree from
// origin/main, rebase on origin/main and push straight to main (no PRs). GIT_PUSH=0 (VPS local mode, default): worktree from
// the local main, fast-forward the local main to the commit, never push. Broken data is never committed to main. Decisions are fed back to stage 1 (data/queue.json,
// data/jobs-queue.json) so handled items leave data/review.md. Crash-safe: the conversation lives in SQLite
// (reviewer/state/), a restart with the same date resumes it.
//   npm --prefix reviewer run review -- [--dry-run] [--date=YYYY-MM-DD]
import { randomUUID } from "node:crypto";
import type { StreamOptions, AssistantMessageEventStream } from "@earendil-works/pi-ai";
// @ts-ignore – shared durable, content-free request accounting
import { journal } from "../../scripts/lib/llm.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { AssistantEntry, createRegistry, defineExtension, Harness, hook, section, ToolTask } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { PRICES, totalUsd, usdFor } from "./cost.ts";
import { systemPrompt } from "./prompt.ts";
import { createTools, DATA_FILES, fetchPublicText } from "./tools.ts";
import { applyFeedback } from "../../scripts/lib/review-feedback.mjs";
// @ts-ignore – plain JS module, unit-tested in test/review-session.test.mjs
import { reviewSession } from "../../scripts/lib/review-session.mjs";

// @ts-ignore – shared host-only publication boundary
import { gateCollection, ledgerPath, readLedger, writeLedger, reviewKey } from "../../scripts/lib/content-integrity.mjs";
// @ts-ignore – independent source verifier, never exposed as an agent write tool
import { verifyContent } from "../../scripts/lib/verify-content.mjs";
// @ts-ignore – fresh source retrieval, no cached fallback on access failure
import { sourceDocuments } from "../../scripts/lib/source-documents.mjs";
// @ts-ignore – same publication selector used by drafting
import { findPublished } from "../../scripts/lib/published.mjs";

const ctx = BACKGROUND_CONTEXT;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = new Map(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "1"] as [string, string]; }));
const DRY = args.has("dry-run");
const DATE = args.get("date") ?? new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich" }).format(new Date());
const env = (k: string, d: string) => process.env[k] || d;
const MODEL = env("REVIEW_MODEL", "gpt-6-luna");
const THINKING = "high";
if(MODEL!=="gpt-6-luna")throw new Error("Only gpt-6-luna is permitted for the reviewer");
const MAX_USD = Number(env("REVIEW_MAX_USD", "1.00"));
const DAILY_MAX_USD = Number(env("REVIEW_DAILY_MAX_USD", "3.00"));
const MAX_TOOL_CALLS = Number(env("REVIEW_MAX_TOOL_CALLS", "80")); // pi-durable 1.4.0 has no maxTurns yet
const PUSH = env("GIT_PUSH", "0") === "1"; // 0 = local commits only (VPS), 1 = push to origin main (GitHub Pages mode)
const BASE = env("REVIEW_BASE", PUSH ? "origin/main" : "main");
const STATE = path.resolve(ROOT, env("REVIEW_STATE_DIR", "reviewer/state"));
const AUTHOR = env("GIT_AUTHOR_NAME", "odcpw"), EMAIL = env("GIT_AUTHOR_EMAIL", "odcpw@users.noreply.github.com");
const TAG = `${DATE}${DRY ? "-dry" : ""}`;
const WT = path.join(STATE, `worktree-${TAG}`);
const RUN_FILE = path.join(STATE, `run-${TAG}.json`);
// The usage file is per stored conversation (session), so a fresh session on the same day still counts the earlier spend.
const usageFile = (session: string) => path.join(STATE, `usage-${session}.json`);
let SESSION = TAG;

const log = (...a: unknown[]) => console.log(`[reviewer ${new Date().toLocaleTimeString("de-CH", { timeZone: "Europe/Zurich" })}]`, ...a);
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const readJson = (f: string, d: any) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);
const writeJson = (f: string, v: unknown) => fs.writeFileSync(f, JSON.stringify(v, null, 1));

if (!PRICES[MODEL]) { console.error(`REVIEW_MODEL ${MODEL} has no verified price in reviewer/src/cost.ts – refusing to run.`); process.exit(2); }
if (!process.env.OPENAI_API_KEY) { console.error("OPENAI_API_KEY not set – reviewer skipped."); process.exit(3); }
fs.mkdirSync(STATE, { recursive: true });

/** Spend of all reviewer sessions today (dry and real), from their usage files – the daily/test budget. */
function spentToday(exceptThis: boolean): number {
	return fs.readdirSync(STATE).filter((f) => f.startsWith(`usage-${DATE}`) && (!exceptThis || f !== path.basename(usageFile(SESSION))))
		.reduce((s, f) => s + (readJson(path.join(STATE, f), { usd: 0 }).usd ?? 0), 0);
}

function prepareWorktree() {
	if (fs.existsSync(WT)) { log(`reusing worktree ${path.relative(ROOT, WT)}`); return; }
	if (PUSH) git(ROOT, "fetch", "--quiet", "origin", "main");
	// The review ledger is host-only and never tracked in git (a code sync must not be able to delete it). The worktree
	// works on a private copy; it goes back to the host only after the review commit reached main (syncLedgerBack).
	if (!fs.existsSync(ledgerPath(ROOT))) throw new Error(`review ledger missing: ${ledgerPath(ROOT)} – restore it; do not re-review`);
	git(ROOT, "worktree", "add", "--detach", WT, BASE);
	fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(WT, "node_modules"));
	fs.mkdirSync(path.dirname(ledgerPath(WT)), { recursive: true });
	fs.copyFileSync(ledgerPath(ROOT), ledgerPath(WT));
	log(`worktree ${path.relative(ROOT, WT)} at ${BASE} (${git(WT, "rev-parse", "--short", "HEAD")})`);
}

/** After the review commit is on main: replace the host ledger with the worktree's (atomic rename). */
function syncLedgerBack() {
	const tmp = `${ledgerPath(ROOT)}.tmp-${process.pid}`;
	fs.copyFileSync(ledgerPath(WT), tmp);
	fs.renameSync(tmp, ledgerPath(ROOT));
}

function idsOf(dir: string, file: string): Map<string, string> {
	const items = JSON.parse(fs.readFileSync(path.join(dir, "data", file), "utf8"));
	return new Map(items.map((e: any) => [e.id, JSON.stringify(e)]));
}
function changes() {
	const out: Record<string, { added: string[]; removed: string[]; changed: string[] }> = {};
	for (const f of DATA_FILES) {
		const before = new Map<string, string>(JSON.parse(git(WT, "show", `HEAD:data/${f}`)).map((e: any) => [e.id, JSON.stringify(e)]));
		const after = idsOf(WT, f);
		out[f] = {
			added: [...after.keys()].filter((k) => !before.has(k)),
			removed: [...before.keys()].filter((k) => !after.has(k)),
			changed: [...after.keys()].filter((k) => before.has(k) && before.get(k) !== after.get(k)),
		};
	}
	return out;
}

async function runAgent(run: any): Promise<{ answer: string; status: string; usd: number }> {
	const resumed = run.started === true;
	SESSION = run.session = reviewSession(run, TAG);
	writeJson(RUN_FILE, run);
	log(`${resumed ? "resuming" : "new"} reviewer session ${SESSION}`);
	const otherSpend = spentToday(true);
	const cap = Math.min(MAX_USD, DAILY_MAX_USD - otherSpend);
	if (cap <= 0.05) throw new Error(`daily reviewer budget exhausted (spent ${otherSpend.toFixed(3)} of ${DAILY_MAX_USD})`);
	log(`model ${MODEL} (${THINKING}), cap $${cap.toFixed(2)} this run, $${otherSpend.toFixed(3)} spent today by other runs`);

	let overBudget = false, toolCalls = 0;
	const roots = { input: ROOT, work: WT };
	const registry = createRegistry();
	registry.install(defineExtension({
		name: "safetyradar-reviewer",
		sections: [section("house-rules", () => systemPrompt(ROOT), { tag: false })],
		tools: createTools(roots),
		hooks: [hook(ToolTask, {
			beforeTool: (call) => {
				if (overBudget) return { block: "Budget exhausted: stop now and give the final JSON summary of what you already did." };
				if (++toolCalls > MAX_TOOL_CALLS) return { block: `Tool-call limit (${MAX_TOOL_CALLS}) reached: stop and give the final JSON summary.` };
				log(`tool ${call.name} ${JSON.stringify(call.arguments).slice(0, 160)}`);
				return undefined;
			},
		})],
	}));
	const models = createModels();
	const provider = openaiProvider();
 const instrument = <T extends StreamOptions>(modelId: string, options: T | undefined, start: (options: T) => AssistantMessageEventStream): AssistantMessageEventStream => {
  if (modelId !== "gpt-6-luna") throw new Error("Unapproved reviewer model");
  const meta = { requestId: randomUUID(), model: modelId, endpoint: "/v1/responses", attempt: 1, caller: "editorial-reviewer" };
  const stream = start({ ...options, maxRetries: 0, transport: "sse",
   onPayload: async (payload: unknown, model: Parameters<NonNullable<StreamOptions["onPayload"]>>[1]) => {
    const next = await options?.onPayload?.(payload, model) ?? payload;
    if (!next || typeof next !== "object" || !("model" in next) || next.model !== "gpt-6-luna") throw new Error("Unapproved reviewer request model");
    journal({ ...meta, event: "started" }); return next;
   },
   onResponse: async (response: Parameters<NonNullable<StreamOptions["onResponse"]>>[0], model: Parameters<NonNullable<StreamOptions["onResponse"]>>[1]) => {
    if (response.status >= 400) journal({ ...meta, event: "http_error", status: response.status, usageKnown: false });
    await options?.onResponse?.(response, model);
   },
  } as T);
  void stream.result().then(message => {
   const u = message.usage;
   journal({ ...meta, event: message.stopReason === "error" || message.stopReason === "aborted" ? "provider_error" : "response", usageKnown: !!u?.totalTokens,
    usage: { input: u?.input ?? 0, output: u?.output ?? 0, cached: u?.cacheRead ?? 0, cacheWrite: u?.cacheWrite ?? 0 }, estimatedUsd: usdFor(modelId, u ?? {}) });
  }).catch(() => { journal({ ...meta, event: "transport_error", usageKnown: false }); });
  return stream;
 };
 const stream = provider.stream.bind(provider), simple = provider.streamSimple.bind(provider);
 provider.stream = (model, context, options) => instrument(model.id, options, opts => stream(model, context, opts));
 provider.streamSimple = (model, context, options) => instrument(model.id, options, opts => simple(model, context, opts));
 models.setProvider(provider);
	const storage = await openNodeSqliteStorage(path.join(STATE, `review-${SESSION}.sqlite`));
	const harness = await Harness.open(storage, {
		models, registry,
		settings: { retry: { maxRetries: 0 }, afterFailedRun: "withdraw" },
		identity: { attribution: { name: "safetyradar-reviewer", url: "https://safetyradar.ch" } },
		onReport: (r: any) => log(`report ${r.kind}${r.reason ? " " + r.reason : ""}`),
	}, ctx);
	const root = await harness.root(ctx, { agent: { model: { provider: "openai", modelId: MODEL }, thinkingLevel: THINKING } });
	harness.resume(); // continues a run the previous (crashed) process left unfinished
	if (resumed) log("resuming the stored conversation after a restart");

	let usd = 0, lastUsd = 0, maxStep = 0.05;
	const tick = async () => {
		usd = totalUsd((await harness.usage(ctx)) as any);
		maxStep = Math.max(maxStep, usd - lastUsd); lastUsd = usd;
		writeJson(usageFile(SESSION), { date: DATE, session: SESSION, model: MODEL, usd: +usd.toFixed(5), updated: new Date().toISOString() });
		// Stop before the next request could cross the cap: keep 1.5x the largest single step as margin.
		if (!overBudget && usd + 1.5 * maxStep >= cap) {
			overBudget = true;
			log(`budget guard: $${usd.toFixed(3)} spent, cap $${cap.toFixed(2)} – asking the agent to stop`);
			setTimeout(() => { if (usd >= cap * 0.98) void root.abort(ctx); }, 0);
		}
		if (usd >= cap) { log("hard cap reached – aborting"); await root.abort(ctx); }
	};
	const timer = setInterval(() => void tick().catch(() => {}), 1000);

	run.started = true; writeJson(RUN_FILE, run);
	const content = `Today is ${DATE}. Do the daily review of Safety Radar per the house rules: list_inputs, read data/review.md and the inbox items, dedupe against the published files, verify against sources, edit the data files, run_checks, then give the JSON summary.`;
	const sub = await root.submit({ type: "input", content, requestId: `review-${SESSION}` }, ctx);
	const settled = await sub.wait(ctx);
	clearInterval(timer);
	await tick();
	let answer = "";
	if (settled.status === "done") {
		const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer!), ctx);
		const msg: any = (entry as any)?.model?.[0];
		answer = (msg?.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n");
	}
	await harness.close(ctx);
	return { answer, status: settled.status === "done" ? "done" : `unanswered (${(settled as any).reason ?? "?"})`, usd };
}

function parseSummary(answer: string): any {
	const m = answer.match(/\{[\s\S]*\}/);
	try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
}

function reportBody(sum: any, ch: ReturnType<typeof changes>, usd: number, status: string): string {
	const L: string[] = [`Automated daily review ${DATE} (model ${MODEL}, cost USD ${usd.toFixed(3)}, ${status}). ${PUSH ? "Pushed to main" : "Committed to the local main on the VPS (no push)"} by the host after validation and build.`, ""];
	L.push("### Changes (from the data diff)");
	for (const [f, c] of Object.entries(ch)) {
		for (const id of c.added) L.push(`- added ${f}: \`${id}\``);
		for (const id of c.changed) L.push(`- updated ${f}: \`${id}\``);
		for (const id of c.removed) L.push(`- removed ${f}: \`${id}\``);
	}
	if (sum) {
		const sec = (t: string, a: any[] | undefined, fmt: (x: any) => string) => { if (a?.length) { L.push("", `### ${t}`, ...a.map((x) => `- ${fmt(x)}`)); } };
		sec("Added (reviewer)", sum.added, (x) => `${x.file} \`${x.id}\` – ${x.source ?? ""}`);
		sec("Merged as extra source", sum.merged, (x) => `${x.file} \`${x.id}\` ← ${x.source ?? ""}`);
		sec("Removed", sum.removed, (x) => `${x.file} \`${x.id}\` – ${x.reason ?? ""}`);
		sec("Updated", sum.updated, (x) => `${x.file} \`${x.id}\` – ${x.what ?? ""}`);
		sec("Skipped", sum.skipped, (x) => `${x.item} – ${x.reason}`);
		if (sum.notes) L.push("", "### Notes", String(sum.notes));
	}
	L.push("", "_E-mails and fetched pages were treated as untrusted data. Generated by reviewer/ (Pi Durable)._");
	return L.join("\n");
}

/** Validate + build the worktree as it is now; throws with the tail of the error output. */
function hostChecks() {
	execFileSync("node", [path.join(ROOT, "scripts/validate-data.mjs"), path.join(WT, "data")], { cwd: WT, stdio: "pipe" });
	execFileSync("npm", ["run", "build", "--silent"], { cwd: WT, stdio: "pipe", env: { ...process.env, NOINDEX: "1" } });
}

/** Rebase the review commit on origin/main, re-check, push HEAD:main; one retry after a rejected push, else abort. */
function pushToMain(): string {
	for (let attempt = 1; attempt <= 2; attempt++) {
		git(WT, "fetch", "--quiet", "origin", "main");
		try { git(WT, "rebase", "--quiet", "origin/main"); }
		catch (e: any) { try { git(WT, "rebase", "--abort"); } catch { /* none */ } return `NOT pushed: rebase on origin/main conflicted (${String(e.stderr ?? e.message).trim().slice(-300)})`; }
		try { hostChecks(); } catch (e: any) { return `NOT pushed: checks failed after rebase: ${String(e.stderr ?? e.stdout ?? e.message).slice(-800)}`; }
		try { git(WT, "push", "--quiet", "origin", "HEAD:main"); return `pushed ${git(WT, "rev-parse", "--short", "HEAD")} to main`; }
		catch (e: any) { log(`push attempt ${attempt} rejected: ${String(e.stderr ?? e.message).trim().slice(-300)}`); }
	}
	return "NOT pushed: push to main rejected twice";
}

/** Local mode: fast-forward the local main (checked out in ROOT) to the review commit; rebase it on main once if main moved. */
function commitToLocalMain(): string {
	try {
		if (git(ROOT, "rev-parse", "--abbrev-ref", "HEAD") !== "main") return "NOT committed: ROOT is not on branch main";
		try { git(WT, "rebase", "--quiet", "main"); }
		catch (e: any) { try { git(WT, "rebase", "--abort"); } catch { /* none */ } return `NOT committed: rebase on local main conflicted (${String(e.stderr ?? e.message).trim().slice(-300)})`; }
		try { hostChecks(); } catch (e: any) { return `NOT committed: checks failed after rebase: ${String(e.stderr ?? e.stdout ?? e.message).slice(-800)}`; }
		const sha = git(WT, "rev-parse", "HEAD");
		git(ROOT, "merge", "--ff-only", "--quiet", sha);
		return `committed ${sha.slice(0, 7)} to local main (no push)`;
	} catch (e: any) { return `NOT committed: ${String(e.stderr ?? e.message).trim().slice(-300)}`; }
}

async function main() {
	const run = readJson(RUN_FILE, { date: DATE, dry: DRY, phase: "agent" });
	if (run.phase === "done") { log(`already done for ${TAG}: ${run.result}`); return; }
	prepareWorktree();
	if (run.phase === "agent") {
		const r = await runAgent(run);
		Object.assign(run, { phase: "finalize", answer: r.answer, status: r.status, usd: r.usd });
		writeJson(RUN_FILE, run);
		fs.appendFileSync(path.join(ROOT, "data/llm-usage.jsonl"), JSON.stringify({ script: "reviewer", session: run.session ?? TAG, model: MODEL, date: DATE, usd: +r.usd.toFixed(5), status: r.status }) + "\n");
	}
	const summary = parseSummary(run.answer);
	const heldUrls: string[] = [];
	const ledger = readLedger(WT);
	const catalog = readJson(path.join(ROOT, "data/lesson-refs.json"), []);
	for (const kind of ["accidents", "rulings"]) {
		const file = `${kind}.json`;
		const before = JSON.parse(git(WT, "show", `HEAD:data/${file}`));
		const candidates = readJson(path.join(WT, "data", file), []);
		const gated = await gateCollection({ kind, before, candidates,
			verify: async (entry: any) => {
				const { sources, failures } = await sourceDocuments(entry, fetchPublicText);
				if (!sources.length) return { state: "held", issues: ["source unavailable; previous data retained"] };
				const old = before.find((e: any) => e.id === entry.id);
				let provenance = null;
				if (kind === "rulings" && old && old.published === entry.published && old.publishedSource === entry.publishedSource) provenance = { published: old.published, publishedSource: old.publishedSource, status: "preserved-existing-provenance-not-reaudited" };
				else if (kind === "rulings" && entry.published) {
					const found = await findPublished(entry);
					if (found.published !== entry.published) return { state: "held", issues: ["publication date not independently confirmed"] };
					provenance = { ...found, status: "confirmed", method: "findPublished authoritative selection" };
				}
				const result = await verifyContent({ entry, kind, sources, publicationEvidence: provenance, catalog });
				if (result.state === "verified") ledger[reviewKey(kind, entry.id)] = { ...result, sourceFailures: failures };
				return result;
			},
			onHold: async (hold: any) => {
				const entry = hold.candidate ?? hold.previous;
				const dir = path.join(ROOT, "data/drafts/held"); fs.mkdirSync(dir, { recursive: true });
				writeJson(path.join(dir, `${kind}-${entry.id}.json`), hold);
				heldUrls.push(entry.source?.url, ...(entry.extraSources ?? []).map((s: any) => s.url));
				log(`HELD ${kind}/${entry.id}: ${hold.issues.join("; ")}`);
			},
		});
		writeJson(path.join(WT, "data", file), gated.accepted);
	}
	writeLedger(WT, ledger);
	log(`agent ${run.status}, USD ${Number(run.usd).toFixed(4)}`);
	const ch = changes();
	const diff = git(WT, "diff", "--", ...DATA_FILES.map((f) => `data/${f}`));
	const n = (f: string, k: "added" | "removed") => ch[f][k].length;
	const any = DATA_FILES.some((f) => ch[f].added.length + ch[f].removed.length + ch[f].changed.length);
	// Host-side checks are authoritative, whatever the agent claimed.
	let checks = "not run (no changes)";
	if (any) {
		try { hostChecks(); checks = "passed"; }
		catch (e: any) { checks = `FAILED: ${String(e.stderr ?? e.stdout ?? e.message).slice(-1500)}`; }
	}
	const body = reportBody(summary, ch, Number(run.usd), run.status);
	fs.writeFileSync(path.join(STATE, `review-${TAG}.md`), body + `\n\nChecks: ${checks}\n\nAgent answer:\n\n${run.answer}\n`);
	fs.writeFileSync(path.join(STATE, `review-${TAG}.diff`), diff);
	log(`changes: ${JSON.stringify(ch)}; checks ${checks}; diff ${path.relative(ROOT, path.join(STATE, `review-${TAG}.diff`))}`);

	if (DRY || !any || !checks.startsWith("passed") || run.status !== "done") {
		run.result = DRY ? "dry-run: diff written, nothing pushed" : !any ? "nothing new – nothing pushed"
			: `NOT pushed (changes discarded): ${run.status !== "done" ? run.status : "checks failed"}`;
	} else {
		const title = `Daily review ${DATE}: +${n("accidents.json", "added")} accidents, +${n("rulings.json", "added")} rulings, +${n("jobs.json", "added")} jobs (-${n("jobs.json", "removed")} gone)`;
		git(WT, "add", ...DATA_FILES.map((f) => `data/${f}`));
		git(WT, "-c", `user.name=${AUTHOR}`, "-c", `user.email=${EMAIL}`, "commit", "--quiet", "-m", title, "-m", body);
		run.result = PUSH ? pushToMain() : commitToLocalMain();
		if (run.result.startsWith("pushed") || run.result.startsWith("committed")) syncLedgerBack();
	}
	if (!DRY && run.status === "done" && (!any || run.result.startsWith("pushed") || run.result.startsWith("committed"))) {
		// Feed decisions back to stage 1 only when they reached main (or there was nothing to change), so review.md stops repeating them.
		const fb = applyFeedback(path.join(ROOT, "data"), summary, ch, DATE, { heldUrls });
		log(`feedback to stage 1: ${JSON.stringify(fb)}`);
	} else if (DRY && summary) {
		log(`dry-run: feedback to stage 1 would mark ${JSON.stringify(applyFeedback(path.join(ROOT, "data"), summary, ch, DATE, { dry: true, heldUrls }))}`);
	}
	run.phase = "done"; writeJson(RUN_FILE, run);
	git(ROOT, "worktree", "remove", "--force", WT);
	log(run.result);
	if (run.result.startsWith("NOT ")) process.exitCode = 4; // reported by run-daily.sh as a failed run
}

main().catch((e) => { console.error(`reviewer failed: ${e?.message ?? e}`); process.exit(1); });
