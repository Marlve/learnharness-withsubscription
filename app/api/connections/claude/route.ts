/**
 * GET /api/connections/claude — re-reads `claude auth status` and returns the
 * Claude subscription status (no credentials: the CLI owns its login).
 * PUT /api/connections/claude — body {allowBackgroundUse: boolean}.
 */
import { refreshClaudeStatus, setClaudeBackgroundUse } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(await refreshClaudeStatus());
}

export async function PUT(req: Request) {
	let body: unknown;
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "body must be JSON" }, { status: 400 });
	}
	if (!body || typeof body !== "object" || typeof (body as { allowBackgroundUse?: unknown }).allowBackgroundUse !== "boolean") {
		return Response.json({ error: "body must be {allowBackgroundUse: boolean}" }, { status: 400 });
	}
	try {
		setClaudeBackgroundUse((body as { allowBackgroundUse: boolean }).allowBackgroundUse);
	} catch {
		return Response.json({ error: "The Claude connection settings could not be saved." }, { status: 500 });
	}
	return Response.json(await refreshClaudeStatus());
}
