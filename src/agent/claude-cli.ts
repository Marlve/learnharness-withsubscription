import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { PATHS } from "../../config.ts";
import { CLAUDE_EFFORT_LEVELS, CLAUDE_SUBSCRIPTION, CLAUDE_SUBSCRIPTION_MODEL_IDS, type ClaudeSubscriptionStatus } from "../core/contracts/claude-subscription.ts";
import type { AdmissionScope } from "./subscription-request-cycle.ts";

/** Env the CLI could use to bill an API key or a cloud provider instead of the plan. */
const FALLBACK_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];
const CONSENT_FILE = path.join(PATHS.data, "claude-subscription.json");
const KEY = Symbol.for("lh.claude.cli");

interface State { status: ClaudeSubscriptionStatus; accountId: string; projectsDirectory?: string; listeners: Set<() => void>; controllers: Set<{ controller: AbortController; background: boolean }> }
function state(): State {
	const global = globalThis as typeof globalThis & { [KEY]?: State };
	return global[KEY] ??= { status: { installed: false, connected: false, epoch: 0, ...readConsent() }, accountId: "", listeners: new Set(), controllers: new Set() };
}
function notify(s: State) { for (const listener of s.listeners) { try { listener(); } catch { /* observer isolation */ } } }

export function claudeCliEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of FALLBACK_ENV) delete env[key];
	return env;
}
/** An empty working directory, so no project CLAUDE.md is discovered. */
export function claudeCliWorkdir(): string {
	const dir = path.join(os.tmpdir(), "learnharness-claude");
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function readConsent(): { allowBackgroundUse: boolean; error?: string } {
	try {
		const value = JSON.parse(fs.readFileSync(CONSENT_FILE, "utf-8"));
		if (value?.version !== 1 || typeof value.allowBackgroundUse !== "boolean") throw new Error("shape");
		return { allowBackgroundUse: value.allowBackgroundUse };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { allowBackgroundUse: true };
		return { allowBackgroundUse: false, error: "The saved Claude connection settings could not be read. Change the background setting to rewrite them." };
	}
}
export function setClaudeBackgroundUse(enabled: boolean): void {
	const tmp = `${CONSENT_FILE}.tmp-${process.pid}`;
	fs.mkdirSync(path.dirname(CONSENT_FILE), { recursive: true });
	fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, allowBackgroundUse: enabled })}\n`, { mode: 0o600 });
	fs.renameSync(tmp, CONSENT_FILE);
	const s = state();
	s.status = { ...s.status, allowBackgroundUse: enabled, error: undefined };
	if (!enabled) for (const owner of s.controllers) if (owner.background) owner.controller.abort("background");
	notify(s);
}

/** Re-reads `claude auth status`. Only a claude.ai login counts as connected. */
export async function refreshClaudeStatus(): Promise<ClaudeSubscriptionStatus> {
	const s = state();
	const auth = await new Promise<{ installed: boolean; loggedIn?: boolean; authMethod?: string; orgId?: string; projectsDirectory?: string }>((resolve) => {
		execFile("claude", ["auth", "status"], { env: claudeCliEnv(), cwd: claudeCliWorkdir(), timeout: 15000, windowsHide: true }, (error, stdout) => {
			try { resolve({ installed: true, ...JSON.parse(stdout) }); }
			catch { resolve({ installed: !(error && (error as NodeJS.ErrnoException).code === "ENOENT") }); }
		});
	});
	if (typeof auth.projectsDirectory === "string" && auth.projectsDirectory) s.projectsDirectory = auth.projectsDirectory;
	const connected = auth.loggedIn === true && auth.authMethod === "claude.ai";
	const accountId = connected ? auth.orgId ?? "claude.ai" : "";
	const changed = auth.installed !== s.status.installed || connected !== s.status.connected || accountId !== s.accountId;
	if (changed) {
		if (!connected) for (const owner of s.controllers) owner.controller.abort("all");
		s.accountId = accountId;
		s.status = { ...s.status, installed: auth.installed, connected, epoch: s.status.epoch + 1 };
		notify(s);
	}
	return { ...s.status };
}
/** Where the CLI keeps this app's sessions: its projects dir + the workdir with non-alphanumerics as "-". */
export function claudeSessionsDir(): string | undefined {
	const root = state().projectsDirectory;
	return root ? path.join(root, claudeCliWorkdir().replace(/[^a-zA-Z0-9]/g, "-")) : undefined;
}
export function claudeStatus(): ClaudeSubscriptionStatus { return { ...state().status }; }
export function claudeConnected(): boolean { return state().status.connected; }
export function claudeBackgroundAllowed(): boolean { return claudeConnected() && state().status.allowBackgroundUse; }
export function onClaudeChange(listener: () => void): () => void { const s = state(); s.listeners.add(listener); return () => { s.listeners.delete(listener); }; }

let catalog: Model<Api>[] | undefined;
/** pi-ai's anthropic metadata, relabeled to the subscription route, with --effort levels only. */
function allClaudeModels(): Model<Api>[] {
	catalog ??= anthropicProvider().getModels()
		.filter((m) => (CLAUDE_SUBSCRIPTION_MODEL_IDS as readonly string[]).includes(m.id))
		.map((m) => ({ ...m, provider: CLAUDE_SUBSCRIPTION.logicalId, thinkingLevelMap: { off: null, minimal: null, ...Object.fromEntries(CLAUDE_EFFORT_LEVELS.map((level) => [level, level])) } }));
	return catalog;
}
export function claudeModels(): Model<Api>[] { return claudeConnected() ? allClaudeModels() : []; }
export function claudeModel(id: string): Model<Api> | undefined { return claudeModels().find((m) => m.id === id); }

export function claudeScope(selectedModelId: string): AdmissionScope {
	const s = state();
	if (!s.status.connected || !claudeModel(selectedModelId)) throw new Error("Claude model catalog unavailable");
	return { accountId: s.accountId, epoch: s.status.epoch, authorityRevision: 0, selectedModelId };
}
export function claudeScopeCurrent(scope: AdmissionScope): boolean {
	try { return JSON.stringify(claudeScope(scope.selectedModelId)) === JSON.stringify(scope); } catch { return false; }
}
export function claudeAbortController(background: boolean) {
	const owner = { controller: new AbortController(), background };
	state().controllers.add(owner);
	return { controller: owner.controller, release: () => { state().controllers.delete(owner); } };
}
