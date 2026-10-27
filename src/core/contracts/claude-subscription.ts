/** Claude subscription via the user's local `claude` CLI (`claude -p`). The CLI owns
 * login; the app never sees a credential. Client-safe: no fs, no process. */
export const CLAUDE_SUBSCRIPTION = { logicalId: "claude-subscription", label: "Claude" } as const;

/** Plan-covered models only: Fable needs usage credits on Pro/Max, so it is not listed. */
export const CLAUDE_SUBSCRIPTION_MODEL_IDS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;

/** Passed 1:1 as `--effort`. The CLI cannot turn thinking off, so "off" is never offered. */
export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;

export interface ClaudeSubscriptionStatus {
	/** A `claude` binary answered `claude auth status`. */
	installed: boolean;
	/** loggedIn && authMethod === "claude.ai" — any other login never counts. */
	connected: boolean;
	allowBackgroundUse: boolean;
	/** Bumps whenever installed/connected changes, invalidating admitted scopes. */
	epoch: number;
	error?: string;
}
