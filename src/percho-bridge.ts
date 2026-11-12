/**
 * Percho (desktop GUI host) bridge — local fork addition.
 *
 * Percho has no terminal, so the fleet list / overlay (TUI-only) never shows.
 * When the host declares support (`PERCHO_SUBAGENT_RUNS=1`), this module:
 * - persists agent sessions under `<agentDir>/sessions-subagents/<project>/`
 *   so Percho can open them read-only (see agent-session.ts), and
 * - mirrors every fleet lane onto the owning session's event bus using
 *   Percho's `percho:subagent-runs` protocol (v1), including the live
 *   session object so Percho can attach a real-time inspector.
 *
 * Without the env flag every function here is a no-op: Pi CLI behaviour is
 * unchanged.
 */

import type { FleetEntry } from "./agent-fleet.ts";
import { fleet } from "./agent-fleet.ts";

export const PERCHO_SUBAGENT_RUNS_ENV = "PERCHO_SUBAGENT_RUNS";
export const PERCHO_SUBAGENT_RUNS_CHANNEL = "percho:subagent-runs";
const PROTOCOL_VERSION = 1;

export interface EventBusLike {
	emit(channel: string, data: unknown): void;
}

export function perchoEnabled(): boolean {
	return process.env[PERCHO_SUBAGENT_RUNS_ENV] === "1";
}

/** Same slug rule as Percho's own subagent session directory. */
export function projectSlug(cwd: string): string {
	const slug = cwd.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
	return slug || "default";
}

/** parent session id → that session's extension event bus */
const buses = new Map<string, EventBusLike>();
/** fleet group id → parent session id that opened it */
const groupOwners = new Map<string, string>();
/** fleet entry id → last message signature sent */
const sent = new Map<string, string>();
let unsubscribeFleet: (() => void) | undefined;

/** Called from session_start: remembers which bus belongs to which session. */
export function registerPerchoBus(sessionId: string, events: EventBusLike | undefined): void {
	if (!perchoEnabled() || !sessionId || !events || typeof events.emit !== "function") return;
	buses.set(sessionId, events);
	ensureSubscribed();
}

/** Called when a spawn site opens a fleet group from a session context. */
export function setFleetGroupOwner(groupId: string, parentSessionId: string | undefined): void {
	if (!perchoEnabled() || !parentSessionId) return;
	groupOwners.set(groupId, parentSessionId);
	ensureSubscribed();
}

function ensureSubscribed(): void {
	if (unsubscribeFleet) return;
	unsubscribeFleet = fleet.subscribe(() => syncPercho());
}

function protocolStatus(entry: FleetEntry): "queued" | "running" | "done" | "failed" | "aborted" {
	switch (entry.lane.status) {
		case "queued":
			return "queued";
		case "complete":
			return "done";
		case "failed":
			return "failed";
		case "cancelled":
			return "aborted";
		default:
			return "running";
	}
}

interface SessionIdentity {
	sessionId?: unknown;
	sessionFile?: unknown;
}

/** Push changed lanes to their owning session's bus. Exported for tests. */
export function syncPercho(): void {
	if (!perchoEnabled()) return;
	for (const entry of fleet.list()) {
		const parentSessionId = groupOwners.get(entry.groupId);
		const bus = parentSessionId ? buses.get(parentSessionId) : undefined;
		if (!parentSessionId || !bus) continue;
		const status = protocolStatus(entry);
		const session = entry.session as SessionIdentity | undefined;
		// note = executor progress ("2/5 tasks"); phase = short lane state. Never the
		// streaming transcript text, which changes on every delta.
		const task = entry.note || (status === "running" ? entry.lane.phase : "") || undefined;
		const error = status === "failed" && entry.lane.detail ? entry.lane.detail.slice(0, 500) : undefined;
		const tokens = entry.inputTokens + entry.outputTokens;
		const signature = JSON.stringify([
			status,
			entry.label,
			task,
			tokens,
			entry.modelLabel,
			typeof session?.sessionId === "string" ? session.sessionId : null,
		]);
		if (sent.get(entry.id) === signature) continue;
		sent.set(entry.id, signature);
		try {
			bus.emit(PERCHO_SUBAGENT_RUNS_CHANNEL, {
				v: PROTOCOL_VERSION,
				type: "run",
				parentSessionId,
				runId: entry.id,
				agent: entry.label,
				status,
				...(task ? { task } : {}),
				...(entry.modelLabel ? { model: entry.modelLabel } : {}),
				...(tokens > 0 ? { tokens } : {}),
				...(error ? { error } : {}),
				...(entry.session ? { session: entry.session } : {}),
				...(entry.abort ? { abort: entry.abort } : {}),
			});
		} catch {
			// The host failing to render must never break progress reporting.
		}
	}
}

/** Test seam. */
export function __resetPerchoBridgeForTests(): void {
	unsubscribeFleet?.();
	unsubscribeFleet = undefined;
	buses.clear();
	groupOwners.clear();
	sent.clear();
}
