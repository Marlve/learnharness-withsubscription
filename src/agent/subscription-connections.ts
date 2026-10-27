import { chatGPTBackgroundAllowed, chatGPTConnected, chatGPTScopeCurrent, onChatGPTChange } from "./chatgpt-bridge.ts";
import { nativeSubscriptionId, nativeSubscriptionConnected, nativeSubscriptionBackgroundAllowed, nativeAdmissionCurrent, onNativeSubscriptionChange } from "./subscription-bridge.ts";
import { claudeBackgroundAllowed, claudeConnected, claudeScopeCurrent, onClaudeChange } from "./claude-cli.ts";
import { CLAUDE_SUBSCRIPTION } from "../core/contracts/claude-subscription.ts";
import type { AdmissionScope } from "./subscription-request-cycle.ts";

const CLAUDE = CLAUDE_SUBSCRIPTION.logicalId;
export function isSubscriptionProvider(provider: string | undefined): boolean { return provider === "chatgpt" || provider === CLAUDE || !!(provider && nativeSubscriptionId(provider)); }
export function subscriptionConnected(provider: string): boolean {
	if (provider === "chatgpt") return chatGPTConnected();
	if (provider === CLAUDE) return claudeConnected();
	const native = nativeSubscriptionId(provider); return !!native && nativeSubscriptionConnected(native);
}
/** Ordinary API connections have no subscription background-consent gate. */
export function connectionBackgroundAllowed(provider: string | undefined): boolean {
	if (provider === "chatgpt") return chatGPTBackgroundAllowed();
	if (provider === CLAUDE) return claudeBackgroundAllowed();
	const native = provider ? nativeSubscriptionId(provider) : undefined;
	return native ? nativeSubscriptionBackgroundAllowed(native) : true;
}
export function connectionScopeCurrent(provider: string, scope: AdmissionScope): boolean {
	if (provider === "chatgpt") return chatGPTScopeCurrent(scope);
	if (provider === CLAUDE) return claudeScopeCurrent(scope);
	const native = nativeSubscriptionId(provider); return !!native && nativeAdmissionCurrent(native, scope);
}
export function onSubscriptionChange(listener: () => void): () => void {
	const stopChatGPT = onChatGPTChange(listener), stopNative = onNativeSubscriptionChange(listener), stopClaude = onClaudeChange(listener);
	return () => { stopChatGPT(); stopNative(); stopClaude(); };
}
