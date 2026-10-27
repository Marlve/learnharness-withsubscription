import { randomUUID } from "node:crypto";
import type { JsonObject, JsonValue, Tool, ToolCall } from "@earendil-works/pi-ai";

/** Tool calling for `claude -p` without native tool use: the model writes Claude's trained
 * <invoke> style as text, and the reply is parsed back into pi toolCall blocks. The older
 * <tool_call>{json}</tool_call> style is still accepted. */
const MARKERS = ["<invoke", "<function_calls>", "<tool_call>"];
const INVOKE = /<invoke\s+name="([^"]+)"[^>]*>([\s\S]*?)(<\/invoke>|$)/g;
const PARAMETER = /<parameter\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/parameter>/g;
const JSON_CALL = /<tool_call>([\s\S]*?)(<\/tool_call>|$)/g;

export function claudeToolProtocol(tools: Tool[]): string {
	if (tools.length === 0) return "";
	const declarations = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
	return `## Tool use
You cannot run tools yourself; LearnHarness runs them for you.
The tools you may call are listed below as JSON Schema.
To call tools, end your reply with one or more blocks in exactly this form:
<invoke name="TOOL_NAME">
<parameter name="PARAM_NAME">VALUE</parameter>
</invoke>
Write string values as plain text; write numbers, booleans,
arrays and objects as JSON.
Never repeat a call. Write nothing after your last block: your
reply ends there, and results arrive in the next message as
<tool_result> blocks. If you need no tool, reply normally.
<tools>${JSON.stringify(declarations)}</tools>`;
}

/** A past call, as the model is asked to write it. */
export function formatInvoke(call: ToolCall): string {
	const params = Object.entries(call.arguments).map(([key, value]) => `<parameter name="${key}">${typeof value === "string" ? value : JSON.stringify(value)}</parameter>\n`).join("");
	return `<invoke name="${call.name}" id="${call.id}">\n${params}</invoke>`;
}

/** Where tool calls begin; text from here on is never shown. */
export function toolCallStart(raw: string): number {
	const found = MARKERS.map((marker) => raw.indexOf(marker)).filter((index) => index >= 0);
	return found.length ? Math.min(...found) : -1;
}
/** Text safe to show now: stops at a tool call, and holds back a possible partial marker tail. */
export function visibleText(raw: string): string {
	const start = toolCallStart(raw);
	if (start >= 0) return raw.slice(0, start);
	for (let n = Math.min(Math.max(...MARKERS.map((m) => m.length)) - 1, raw.length); n > 0; n--) {
		const tail = raw.slice(-n);
		if (MARKERS.some((marker) => marker.startsWith(tail))) return raw.slice(0, -n);
	}
	return raw;
}

/** String-typed parameters stay raw text ("7" must not become 7); everything else is JSON when it parses. */
function parameterValue(tool: Tool | undefined, key: string, raw: string): JsonValue {
	const type = (tool?.parameters as { properties?: Record<string, { type?: unknown }> } | undefined)?.properties?.[key]?.type;
	const text = raw.replace(/^\n/, "").replace(/\n$/, "");
	if (type === "string") return text;
	try { return JSON.parse(text.trim()) as JsonValue; } catch (error) {
		// TEMP diagnostic: remove once the malformed-call cause is confirmed.
		if (type !== undefined) console.error(`[claude-tool-debug] parameter "${key}" (type ${String(type)}) is not valid JSON: ${error instanceof Error ? error.message : error}\n${text}`);
		return text;
	}
}

const newId = () => `call_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
/** Every tool call in the reply, in order, with exact repeats dropped. */
export function parseToolCalls(text: string, tools: readonly Tool[]): ToolCall[] {
	const found: { index: number; call: ToolCall }[] = [];
	for (const match of text.matchAll(INVOKE)) {
		const [, name, body, close] = match as unknown as [string, string, string, string];
		if (!close) { found.push({ index: match.index, call: { type: "toolCall", id: newId(), name, arguments: {}, argumentsError: `Tool call was cut off before </invoke>: ${match[0]}` } }); continue; }
		const tool = tools.find((t) => t.name === name), args: JsonObject = {};
		for (const [, key, raw] of body.matchAll(PARAMETER) as IterableIterator<[string, string, string]>) args[key] = parameterValue(tool, key, raw);
		found.push({ index: match.index, call: { type: "toolCall", id: newId(), name, arguments: args } });
	}
	for (const match of text.matchAll(JSON_CALL)) {
		const raw = (match[1] ?? "").trim();
		try {
			const value = JSON.parse(raw) as { name?: unknown; arguments?: unknown };
			const args = value.arguments ?? {};
			if (typeof value.name !== "string" || typeof args !== "object" || Array.isArray(args) || args === null) throw new Error("expected {name, arguments}");
			found.push({ index: match.index, call: { type: "toolCall", id: newId(), name: value.name, arguments: args as JsonObject } });
		} catch (error) {
			const name = /"name"\s*:\s*"([^"]+)"/.exec(raw)?.[1] ?? "unknown";
			found.push({ index: match.index, call: { type: "toolCall", id: newId(), name, arguments: {}, argumentsError: `Tool call was not valid JSON (${error instanceof Error ? error.message : "parse error"}): ${raw}` } });
		}
	}
	const seen = new Set<string>();
	return found.sort((a, b) => a.index - b.index).map(({ call }) => call).filter((call) => {
		const key = `${call.name}\n${JSON.stringify(call.arguments)}`;
		if (seen.has(key)) return false;
		seen.add(key); return true;
	});
}

/** True once a complete call repeats an earlier one: the model is looping and can be stopped. */
export function repeatsCall(text: string, tools: readonly Tool[]): boolean {
	const complete = text.match(/<\/invoke>|<\/tool_call>/g)?.length ?? 0;
	return complete > parseToolCalls(text, tools).length;
}
