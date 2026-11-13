import { randomUUID } from 'node:crypto';

// Which stored reviewer conversation (SQLite file + submit requestId) a run uses.
// pi-durable dedupes submits by requestId, so reusing a finished session returns its stored answer without a model call.
// Only a run that already started (crash/restart) resumes; anything else gets a fresh session. Runs from before this
// field existed resumed under the bare date tag, so that stays the fallback for them.
export function reviewSession(run, tag, fresh = () => randomUUID().slice(0, 8)) {
  if (run?.started === true) return run.session ?? tag;
  return `${tag}-${fresh()}`;
}
