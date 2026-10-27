import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { Api, AssistantMessage, Message, Model, SimpleStreamOptions, StreamFunction, TextContent, ThinkingContent } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { CLAUDE_EFFORT_LEVELS, CLAUDE_SUBSCRIPTION } from "../core/contracts/claude-subscription.ts";
import { claudeAbortController, claudeBackgroundAllowed, claudeCliEnv, claudeCliWorkdir, claudeScope, claudeScopeCurrent } from "./claude-cli.ts";
import { claudeToolProtocol, formatInvoke, parseToolCalls, repeatsCall, toolCallStart, visibleText } from "./claude-tool-protocol.ts";
import { cleanupStaleSessions, deleteSession, findSession, fingerprintChain, rememberSession } from "./claude-sessions.ts";
import { markUnadmittedUsage, type AdmissionScope, type NoDispatchKind, type SubscriptionDispatchLifecycle } from "./subscription-request-cycle.ts";


export function claudeSubscriptionError(message: string): string {
	const suffix = " No API-key fallback was used.";
	if (/background/i.test(message)) return `Claude background use is off in this app. Enable it in Providers to run this work.${suffix}`;
	if (/credits/i.test(message)) return `This Claude model needs usage credits on your plan. Choose another Claude model.${suffix}`;
	if (/quota|429|rate.?limit|usage limit|limit reached/i.test(message)) return `Claude plan usage limit reached. Check https://claude.ai/settings/usage and try again later.${suffix}`;
	if (/ENOENT|not found/i.test(message)) return `Claude Code (\`claude\`) was not found on this computer. Install it, sign in, then Refresh in Providers.${suffix}`;
	if (/log ?in|logged|auth|401/i.test(message)) return `Claude Code is not signed in with your Claude account. Run \`claude auth login\`, then Refresh in Providers.${suffix}`;
	if (/cancel|abort|closed/i.test(message)) return `Claude request cancelled.${suffix}`;
	if (/catalog|model|stale|changed/i.test(message)) return `The selected Claude model or connection is unavailable. Refresh Providers and explicitly choose an available model.${suffix}`;
	return `Claude request failed. Check Claude Code and your plan limits, then retry.${suffix}`;
}

type CliBlock = { type: "text"; text: string } | { type: "image"; source: { type: "base64"; media_type: string; data: string } };
/** One transcript message as CLI blocks; also the fingerprint input, so it must be deterministic. */
export function serializeMessage(m: Message): CliBlock[] {
	const blocks: CliBlock[] = [];
	let text = "";
	const image = (data: string, mimeType: string) => { if (text) blocks.push({ type: "text", text }); text = ""; blocks.push({ type: "image", source: { type: "base64", media_type: mimeType, data } }); };
	if (m.role === "user") {
		text += `<turn role="user">`;
		if (typeof m.content === "string") text += m.content;
		else for (const part of m.content) { if (part.type === "text") text += part.text; else image(part.data, part.mimeType); }
		text += "</turn>\n";
	} else if (m.role === "assistant") {
		const body = m.content.map((part) => part.type === "text" ? part.text : part.type === "toolCall" ? formatInvoke(part) : "").join("");
		if (body) text += `<turn role="assistant">${body}</turn>\n`;
	} else if (m.role === "toolResult") {
		text += `<tool_result id="${m.toolCallId}" name="${m.toolName}" error="${m.isError}">`;
		for (const part of m.content) { if (part.type === "text") text += part.text; else image(part.data, part.mimeType); }
		text += "</tool_result>\n";
	}
	if (text) blocks.push({ type: "text", text });
	return blocks;
}
/** Messages as ONE user message: adjacent text merged, inline base64 images kept in place. */
export function claudeHistory(messages: Message[]): CliBlock[] {
	const blocks: CliBlock[] = [];
	for (const block of [...messages.flatMap(serializeMessage), { type: "text" as const, text: "Continue as the assistant from here." }]) {
		const last = blocks.at(-1);
		if (block.type === "text" && last?.type === "text") last.text += block.text;
		else blocks.push({ ...block });
	}
	return blocks;
}

function empty(model: Model<Api>): AssistantMessage {
	return { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [], stopReason: "error", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

export function claudeCliStream(background: () => boolean, lifecycle?: SubscriptionDispatchLifecycle): StreamFunction<Api, SimpleStreamOptions> {
	return (model, context, options) => {
		const output = new AssistantMessageEventStream();
		const purpose = background();
		const { controller, release } = claudeAbortController(purpose);
		const signal = options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
		void (async () => {
			let partial = empty(model), scope: AdmissionScope | undefined, committed = false, promptFile: string | undefined, runSession: string | undefined;
			const check = () => {
				if (signal.aborted || !scope || !claudeScopeCurrent(scope)) throw new Error("cancelled or connection changed");
				if (purpose && !claudeBackgroundAllowed()) throw new Error("background use disabled");
			};
			try {
				if (model.provider !== CLAUDE_SUBSCRIPTION.logicalId) throw new Error("model unavailable");
				scope = claudeScope(model.id); lifecycle?.captured(scope);
				check();
				const workdir = claudeCliWorkdir();
				cleanupStaleSessions();
				const tools = getCurrentTools(context.messages);
				const system = [getCurrentSystemPrompt(context.messages), claudeToolProtocol(tools)].filter(Boolean).join("\n\n");
				promptFile = path.join(workdir, `system-${randomUUID()}.txt`);
				fs.writeFileSync(promptFile, system);
				const messages = context.messages.filter((m) => m.role !== "system");
				const chain = fingerprintChain(`${model.id}\n${system}`, messages.map((m) => JSON.stringify(serializeMessage(m))));
				// Resume only after an assistant reply: that is where a remembered session ends.
				const resume = findSession(chain, (index) => messages[index - 1]?.role === "assistant");
				const effort = (CLAUDE_EFFORT_LEVELS as readonly string[]).includes(options?.reasoning ?? "") ? ["--effort", options!.reasoning!] : [];
				const args = ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose", "--include-partial-messages", "--model", model.id, ...effort, ...(resume ? ["--resume", resume.sessionId, "--fork-session"] : []), "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--disable-slash-commands", "--system-prompt-file", promptFile];
				check(); lifecycle?.beforeDispatch(scope); committed = true;
				const child = spawn("claude", args, { cwd: workdir, env: claudeCliEnv(), windowsHide: true });
				const kill = () => child.kill();
				signal.addEventListener("abort", kill, { once: true });
				const exited = new Promise<{ code: number | null; error?: Error }>((resolve) => { child.on("error", (error) => resolve({ code: null, error })); child.on("close", (code) => resolve({ code })); });
				child.stdin.end(`${JSON.stringify({ type: "user", message: { role: "user", content: claudeHistory(messages.slice(resume?.index ?? 0)) } })}\n`);
				let stderr = "";
				child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });

				const content: (TextContent | ThinkingContent)[] = [];
				let raw = "", shown = "", started = false, looped = false, streamUsage: Record<string, number | { thinking_tokens?: number }> = {}, result: { is_error?: boolean; result?: string; stop_reason?: string; usage?: Record<string, number | { thinking_tokens?: number }> } | undefined;
				const update = () => { partial = { ...partial, content: [...content] }; };
				const start = () => { if (!started) { started = true; output.push({ type: "start", partial }); } };
				const block = <T extends TextContent | ThinkingContent>(kind: T["type"]): number => {
					if (content.at(-1)?.type === kind) return content.length - 1;
					if (content.length > 0) endBlock(content.length - 1);
					content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" }); update(); start();
					output.push({ type: kind === "text" ? "text_start" : "thinking_start", contentIndex: content.length - 1, partial });
					return content.length - 1;
				};
				const endBlock = (index: number) => {
					const part = content[index]!;
					output.push(part.type === "text" ? { type: "text_end", contentIndex: index, content: part.text, partial } : { type: "thinking_end", contentIndex: index, content: part.thinking, partial });
				};
				let buffer = "";
				for await (const chunk of child.stdout) {
					buffer += chunk;
					let newline: number;
					while ((newline = buffer.indexOf("\n")) >= 0) {
						const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
						if (!line) continue;
						let event: { type?: string; session_id?: string; event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string }; usage?: typeof streamUsage; message?: { usage?: typeof streamUsage } } } & NonNullable<typeof result>;
						try { event = JSON.parse(line); } catch { continue; }
						if (typeof event.session_id === "string") runSession = event.session_id;
						if (event.type === "result") { result = event; continue; }
						// Kept in case the run is stopped early and no result event arrives.
						const eventUsage = event.type === "stream_event" ? event.event?.message?.usage ?? event.event?.usage : undefined;
						if (eventUsage) streamUsage = { ...streamUsage, ...eventUsage };
						const delta = event.type === "stream_event" && event.event?.type === "content_block_delta" ? event.event.delta : undefined;
						if (delta?.type === "thinking_delta" && delta.thinking) {
							const index = block<ThinkingContent>("thinking");
							(content[index] as ThinkingContent).thinking += delta.thinking; update();
							output.push({ type: "thinking_delta", contentIndex: index, delta: delta.thinking, partial });
						} else if (delta?.type === "text_delta" && delta.text) {
							raw += delta.text;
							const next = visibleText(raw);
							if (next.length > shown.length) {
								const index = block<TextContent>("text"), piece = next.slice(shown.length); shown = next;
								(content[index] as TextContent).text += piece; update();
								output.push({ type: "text_delta", contentIndex: index, delta: piece, partial });
							}
							// No stop sequence exists for these calls, so a model that repeats a call is cut off.
							if (!looped && delta.text.includes("</") && repeatsCall(raw, tools)) { looped = true; child.kill(); }
						}
					}
				}
				const { code, error } = await exited;
				signal.removeEventListener("abort", kill);
				if (signal.aborted) throw new Error("cancelled");
				if (error) throw error;
				if (!result && !looped) throw new Error(stderr.trim() || `claude exited with code ${code}`);
				if (result?.is_error) throw new Error(result.result || "claude reported an error");

				const usage = result?.usage ?? streamUsage;
				const num = (key: string) => typeof usage[key] === "number" ? usage[key] as number : 0;
				const thinking = (usage.output_tokens_details as { thinking_tokens?: number } | undefined)?.thinking_tokens;
				partial.usage = { input: num("input_tokens"), output: num("output_tokens"), cacheRead: num("cache_read_input_tokens"), cacheWrite: num("cache_creation_input_tokens"), ...(thinking !== undefined ? { reasoning: thinking } : {}), totalTokens: num("input_tokens") + num("output_tokens") + num("cache_read_input_tokens") + num("cache_creation_input_tokens"), cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
				// No tool call came, so a held-back partial marker tail was ordinary text after all.
				const open = toolCallStart(raw), rest = (open >= 0 ? raw.slice(0, open) : raw).slice(shown.length);
				if (rest) { const index = block<TextContent>("text"); (content[index] as TextContent).text += rest; update(); output.push({ type: "text_delta", contentIndex: index, delta: rest, partial }); }
				const last = content.at(-1);
				if (last?.type === "text") last.text = last.text.trimEnd();
				if (last) { update(); endBlock(content.length - 1); }
				start();
				const calls = parseToolCalls(raw, tools);
				// TEMP diagnostic: remove once the malformed-call cause is confirmed.
				if ((raw.match(/<parameter\b/g)?.length ?? 0) !== (raw.match(/<\/parameter>/g)?.length ?? 0) || (raw.match(/<invoke\b/g)?.length ?? 0) !== (raw.match(/<\/invoke>/g)?.length ?? 0)) console.error("[claude-tool-debug] mismatched tags in raw reply:\n" + raw);
				for (const call of calls) {
					const index = partial.content.length;
					partial = { ...partial, content: [...partial.content, call] };
					output.push({ type: "toolcall_start", contentIndex: index, partial });
					output.push({ type: "toolcall_end", contentIndex: index, toolCall: call, partial });
				}
				const reason = calls.length ? "toolUse" : result?.stop_reason === "max_tokens" ? "length" : "stop";
				partial = { ...partial, stopReason: reason };
				// A cut-off session holds the repeated calls, so it is never resumed.
				if (runSession && looped) deleteSession(runSession);
				else if (runSession) rememberSession(fingerprintChain(`${model.id}\n${system}`, [...messages, partial].map((m) => JSON.stringify(serializeMessage(m)))).at(-1)!, runSession);
				output.push({ type: "done", reason, message: partial });
			} catch (error) {
				if (runSession) deleteSession(runSession);
				if (!committed) {
					markUnadmittedUsage(partial.usage);
					const kind: NoDispatchKind = options?.signal?.aborted || controller.signal.reason === "all" ? "all" : controller.signal.reason === "background" || (purpose && !claudeBackgroundAllowed()) ? "background" : "other";
					lifecycle?.noDispatch(kind);
				}
				partial = { ...partial, stopReason: signal.aborted ? "aborted" : "error", errorMessage: claudeSubscriptionError(error instanceof Error ? error.message : "") };
				output.push({ type: "error", reason: partial.stopReason as "error" | "aborted", error: partial });
			} finally {
				release(); output.end();
				if (promptFile) fs.rm(promptFile, { force: true }, () => {});
			}
		})();
		return output;
	};
}
