"use client";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { CLAUDE_SUBSCRIPTION, type ClaudeSubscriptionStatus } from "@/src/core";
import { Button } from "@/components/ui/button";
import { notifySettingsSaved } from "@/components/settings-signal";
import { ConnectionDialog, ConnectionFooter, ConnectionRow } from "./connection-controls";
import { Toggle } from "./controls";

export const CLAUDE_NOTICE = "Your prompts, tool results, and relevant session context are sent to Claude through your local Claude Code (`claude`) to run the work you select. LearnHarness stores no Claude credentials; Claude Code manages its own sign-in. Provider terms, data-use policies, and plan limits apply. This connection never falls back to an API key.";
const BACKGROUND_HINT = "Allow LearnHarness helper agents and automatic follow-ups to use this connection.";
const EMPTY: ClaudeSubscriptionStatus = { installed: false, connected: false, allowBackgroundUse: true, epoch: 0 };

function statusLine(status: ClaudeSubscriptionStatus): string {
	if (status.connected) return "Signed in with your Claude account.";
	if (status.installed) return "Not signed in: run `claude auth login` in a terminal, then Refresh.";
	return "Claude Code not found. Install it and sign in, then Refresh.";
}

const Context = createContext({ status: EMPTY, busy: false, open: () => {}, setBackground: (_enabled: boolean) => {} });

export function ClaudeUIProvider({ children }: { children: React.ReactNode }) {
	const [status, setStatus] = useState(EMPTY), [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
	const mounted = useRef(false), last = useRef(EMPTY);
	async function request(init?: RequestInit) {
		setBusy(true); setError(null);
		try {
			const response = await fetch("/api/connections/claude", init);
			const body = await response.json();
			if (!response.ok) throw new Error(body?.error);
			if (!mounted.current) return;
			const next = body as ClaudeSubscriptionStatus;
			if (next.connected !== last.current.connected || next.allowBackgroundUse !== last.current.allowBackgroundUse) notifySettingsSaved("keys");
			last.current = next; setStatus(next);
		} catch { if (mounted.current) setError("The Claude connection could not be checked or changed. Try again."); }
		finally { if (mounted.current) setBusy(false); }
	}
	const refresh = () => request();
	const setBackground = (enabled: boolean) => request({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ allowBackgroundUse: enabled }) });
	useEffect(() => { mounted.current = true; void refresh(); return () => { mounted.current = false; }; }, []);
	return <Context.Provider value={{ status, busy, open: () => { setError(null); setOpen(true); void refresh(); }, setBackground: (enabled) => void setBackground(enabled) }}>
		{children}
		{open && <ConnectionDialog label={`${CLAUDE_SUBSCRIPTION.label} connection`} testid="claude-connection-dialog" backdropTestid="claude-dialog-backdrop" busy={false} onClose={() => setOpen(false)}>
			<h2 className="text-sm font-semibold text-foreground">{CLAUDE_SUBSCRIPTION.label}</h2>
			<p className="mt-3 text-xs leading-relaxed text-muted-foreground" data-testid="claude-privacy-notice">{CLAUDE_NOTICE}</p>
			<p role="status" className="mt-3 text-xs text-foreground" data-testid="claude-status">{statusLine(status)}</p>
			<div className="mt-4 flex items-center gap-3 text-xs text-foreground">
				<Toggle label="Allow background use" checked={status.allowBackgroundUse} disabled={busy} onChange={(enabled) => void setBackground(enabled)} />
				<span>Allow background use<span className="mt-1 block leading-relaxed text-muted-foreground">{BACKGROUND_HINT}</span></span>
			</div>
			{(error || status.error) && <p role="alert" className="mt-3 text-xs text-red-400">{error || status.error}</p>}
			<ConnectionFooter testid="claude-connection-footer">
				<Button variant="outline" size="sm" disabled={busy} onClick={() => void refresh()}>Refresh</Button>
				<Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Close</Button>
			</ConnectionFooter>
		</ConnectionDialog>}
	</Context.Provider>;
}

export function ClaudeConnection() {
	const ui = useContext(Context);
	return <div className="flex flex-col gap-2" data-testid="claude-subscription-connection">
		<ConnectionRow label={CLAUDE_SUBSCRIPTION.label} action="Manage…" disabled={false} onAction={ui.open} />
		{ui.status.error && <p role="alert" className="text-xs text-red-400">{ui.status.error}</p>}
	</div>;
}

export function ClaudeBackgroundAccess({ provider }: { provider: string | undefined }) {
	const ui = useContext(Context);
	if (provider !== CLAUDE_SUBSCRIPTION.logicalId || !ui.status.connected || ui.status.allowBackgroundUse) return null;
	return <Button type="button" size="xs" variant="ghost" disabled={ui.busy} onClick={ui.open}>Enable background use</Button>;
}
