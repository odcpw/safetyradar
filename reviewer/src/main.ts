#!/usr/bin/env node
// Stage 2: the daily editorial reviewer. A Pi Durable agent edits data/accidents.json, rulings.json and jobs.json in a
// separate detached git worktree from origin/main; the host then validates and builds, commits, rebases on origin/main and
// pushes straight to main (no PRs). Broken data is never pushed. Decisions are fed back to stage 1 (data/queue.json,
// data/jobs-queue.json) so handled items leave data/review.md. Crash-safe: the conversation lives in SQLite
// (reviewer/state/), a restart with the same date resumes it.
//   npm --prefix reviewer run review -- [--dry-run] [--date=YYYY-MM-DD]
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { AssistantEntry, createRegistry, defineExtension, Harness, hook, section, ToolTask } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { PRICES, totalUsd } from "./cost.ts";
import { systemPrompt } from "./prompt.ts";
import { createTools, DATA_FILES } from "./tools.ts";
import { applyFeedback } from "../../scripts/lib/review-feedback.mjs";

const ctx = BACKGROUND_CONTEXT;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = new Map(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "1"] as [string, string]; }));
const DRY = args.has("dry-run");
const DATE = args.get("date") ?? new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Zurich" }).format(new Date());
const env = (k: string, d: string) => process.env[k] || d;
const MODEL = env("REVIEW_MODEL", "gpt-6.1-sol");
const THINKING = env("REVIEW_THINKING", "medium") as any;
const MAX_USD = Number(env("REVIEW_MAX_USD", "1.00"));
const DAILY_MAX_USD = Number(env("REVIEW_DAILY_MAX_USD", "3.00"));
const MAX_TOOL_CALLS = Number(env("REVIEW_MAX_TOOL_CALLS", "80")); // pi-durable 1.4.0 has no maxTurns yet
const BASE = env("REVIEW_BASE", "origin/main");
const STATE = path.resolve(ROOT, env("REVIEW_STATE_DIR", "reviewer/state"));
const AUTHOR = env("GIT_AUTHOR_NAME", "odcpw"), EMAIL = env("GIT_AUTHOR_EMAIL", "odcpw@users.noreply.github.com");
const TAG = `${DATE}${DRY ? "-dry" : ""}`;
const WT = path.join(STATE, `worktree-${TAG}`);
const RUN_FILE = path.join(STATE, `run-${TAG}.json`);
const USAGE_FILE = path.join(STATE, `usage-${TAG}.json`);

const log = (...a: unknown[]) => console.log(`[reviewer ${new Date().toLocaleTimeString("de-CH", { timeZone: "Europe/Zurich" })}]`, ...a);
const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const readJson = (f: string, d: any) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);
const writeJson = (f: string, v: unknown) => fs.writeFileSync(f, JSON.stringify(v, null, 1));

if (!PRICES[MODEL]) { console.error(`REVIEW_MODEL ${MODEL} has no verified price in reviewer/src/cost.ts – refusing to run.`); process.exit(2); }
if (!process.env.OPENAI_API_KEY) { console.error("OPENAI_API_KEY not set – reviewer skipped."); process.exit(3); }
fs.mkdirSync(STATE, { recursive: true });

/** Spend of all reviewer sessions today (dry and real), from their usage files – the daily/test budget. */
function spentToday(exceptThis: boolean): number {
	return fs.readdirSync(STATE).filter((f) => f.startsWith(`usage-${DATE}`) && (!exceptThis || f !== path.basename(USAGE_FILE)))
		.reduce((s, f) => s + (readJson(path.join(STATE, f), { usd: 0 }).usd ?? 0), 0);
}

function prepareWorktree() {
	if (fs.existsSync(WT)) { log(`reusing worktree ${path.relative(ROOT, WT)}`); return; }
	git(ROOT, "fetch", "--quiet", "origin", "main");
	git(ROOT, "worktree", "add", "--detach", WT, BASE);
	fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(WT, "node_modules"));
	log(`worktree ${path.relative(ROOT, WT)} at ${BASE} (${git(WT, "rev-parse", "--short", "HEAD")})`);
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
	models.setProvider(openaiProvider());
	const storage = await openNodeSqliteStorage(path.join(STATE, `review-${TAG}.sqlite`));
	const harness = await Harness.open(storage, {
		models, registry,
		settings: { retry: { maxRetries: 2 }, afterFailedRun: "withdraw" },
		identity: { attribution: { name: "safetyradar-reviewer", url: "https://safetyradar.ch" } },
		onReport: (r: any) => log(`report ${r.kind}${r.reason ? " " + r.reason : ""}`),
	}, ctx);
	const root = await harness.root(ctx, { agent: { model: { provider: "openai", modelId: MODEL }, thinkingLevel: THINKING } });
	const resumed = run.started === true;
	harness.resume(); // continues a run the previous (crashed) process left unfinished
	if (resumed) log("resuming the stored conversation after a restart");

	let usd = 0, lastUsd = 0, maxStep = 0.05;
	const tick = async () => {
		usd = totalUsd((await harness.usage(ctx)) as any);
		maxStep = Math.max(maxStep, usd - lastUsd); lastUsd = usd;
		writeJson(USAGE_FILE, { date: DATE, session: TAG, model: MODEL, usd: +usd.toFixed(5), updated: new Date().toISOString() });
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
	const sub = await root.submit({ type: "input", content, requestId: `review-${TAG}` }, ctx);
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
	const L: string[] = [`Automated daily review ${DATE} (model ${MODEL}, cost USD ${usd.toFixed(3)}, ${status}). Pushed to main by the host after validation and build.`, ""];
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

async function main() {
	const run = readJson(RUN_FILE, { date: DATE, dry: DRY, phase: "agent" });
	if (run.phase === "done") { log(`already done for ${TAG}: ${run.result}`); return; }
	prepareWorktree();
	if (run.phase === "agent") {
		const r = await runAgent(run);
		Object.assign(run, { phase: "finalize", answer: r.answer, status: r.status, usd: r.usd });
		writeJson(RUN_FILE, run);
		fs.appendFileSync(path.join(ROOT, "data/llm-usage.jsonl"), JSON.stringify({ script: "reviewer", session: TAG, model: MODEL, date: DATE, usd: +r.usd.toFixed(5), status: r.status }) + "\n");
	}
	const summary = parseSummary(run.answer);
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
		run.result = pushToMain();
	}
	if (!DRY && run.status === "done" && (!any || run.result.startsWith("pushed"))) {
		// Feed decisions back to stage 1 only when they reached main (or there was nothing to change), so review.md stops repeating them.
		const fb = applyFeedback(path.join(ROOT, "data"), summary, ch, DATE);
		log(`feedback to stage 1: ${JSON.stringify(fb)}`);
	} else if (DRY && summary) {
		log(`dry-run: feedback to stage 1 would mark ${JSON.stringify(applyFeedback(path.join(ROOT, "data"), summary, ch, DATE, { dry: true }))}`);
	}
	run.phase = "done"; writeJson(RUN_FILE, run);
	git(ROOT, "worktree", "remove", "--force", WT);
	log(run.result);
	if (run.result.startsWith("NOT pushed")) process.exitCode = 4; // reported by run-daily.sh as a failed run
}

main().catch((e) => { console.error(`reviewer failed: ${e?.message ?? e}`); process.exit(1); });
