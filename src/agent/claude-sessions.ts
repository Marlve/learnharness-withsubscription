import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { claudeSessionsDir } from "./claude-cli.ts";

/** Content-addressed reuse of `claude -p` sessions: a session is resumed only when the
 * request starts with exactly the transcript it already holds. Sessions are forked on
 * every resume, so each entry is immutable and branches never collide. */
const MAX_SESSIONS = 200;
const UUID_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
const KEY = Symbol.for("lh.claude.sessions");
interface State { sessions: Map<string, string>; cleaned: boolean }
function state(): State {
	const global = globalThis as typeof globalThis & { [KEY]?: State };
	return global[KEY] ??= { sessions: new Map(), cleaned: false };
}

/** chain[i] fingerprints the seed plus the first i items. */
export function fingerprintChain(seed: string, items: readonly string[]): string[] {
	const chain = [createHash("sha256").update(seed).digest("hex")];
	for (const item of items) chain.push(createHash("sha256").update(chain.at(-1)!).update(item).digest("hex"));
	return chain;
}

function sessionFile(sessionId: string): string | undefined {
	const dir = claudeSessionsDir(), name = `${sessionId}.jsonl`;
	return dir && UUID_FILE.test(name) ? path.join(dir, name) : undefined;
}
export function deleteSession(sessionId: string): void {
	const file = sessionFile(sessionId);
	if (file) fs.rm(file, { force: true }, () => {});
}

/** The in-memory map dies with the process, so files left by an earlier run are unreachable. */
export function cleanupStaleSessions(): void {
	const s = state(), dir = claudeSessionsDir();
	if (s.cleaned || !dir) return;
	s.cleaned = true;
	let names: string[];
	try { names = fs.readdirSync(dir); } catch { return; }
	for (const name of names) if (UUID_FILE.test(name)) fs.rm(path.join(dir, name), { force: true }, () => {});
}

/** The longest remembered prefix whose session file still exists, at a position `allowed` accepts. */
export function findSession(chain: readonly string[], allowed: (index: number) => boolean): { sessionId: string; index: number } | undefined {
	const sessions = state().sessions;
	for (let index = chain.length - 1; index > 0; index--) {
		const sessionId = sessions.get(chain[index]!);
		if (!sessionId || !allowed(index)) continue;
		const file = sessionFile(sessionId);
		if (file && fs.existsSync(file)) return { sessionId, index };
	}
	return undefined;
}

export function rememberSession(fingerprint: string, sessionId: string): void {
	const sessions = state().sessions;
	sessions.delete(fingerprint);
	sessions.set(fingerprint, sessionId);
	while (sessions.size > MAX_SESSIONS) {
		const [oldest, oldId] = sessions.entries().next().value!;
		sessions.delete(oldest);
		// A fork child holds its own copy of the transcript, so the parent file is not shared.
		if (![...sessions.values()].includes(oldId)) deleteSession(oldId);
	}
}
