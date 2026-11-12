/**
 * Local fork addition: Percho bridge (fleet lanes → `percho:subagent-runs`).
 */

import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fleet } from "../src/agent-fleet.ts";
import {
	__resetPerchoBridgeForTests,
	PERCHO_SUBAGENT_RUNS_CHANNEL,
	PERCHO_SUBAGENT_RUNS_ENV,
	projectSlug,
	registerPerchoBus,
	setFleetGroupOwner,
} from "../src/percho-bridge.ts";

type Sent = { channel: string; data: Record<string, unknown> };

function bus() {
	const sent: Sent[] = [];
	return { sent, events: { emit: (channel: string, data: unknown) => sent.push({ channel, data: data as Record<string, unknown> }) } };
}

let previous: string | undefined;

beforeEach(() => {
	previous = process.env[PERCHO_SUBAGENT_RUNS_ENV];
	__resetPerchoBridgeForTests();
	fleet.clear();
});

afterEach(() => {
	if (previous === undefined) delete process.env[PERCHO_SUBAGENT_RUNS_ENV];
	else process.env[PERCHO_SUBAGENT_RUNS_ENV] = previous;
	__resetPerchoBridgeForTests();
	fleet.clear();
});

describe("percho bridge", () => {
	it("is inert without the host flag", () => {
		delete process.env[PERCHO_SUBAGENT_RUNS_ENV];
		const b = bus();
		registerPerchoBus("parent", b.events);
		setFleetGroupOwner("g", "parent");
		const group = fleet.registerGroup({ groupId: "g", role: "executor", lanes: [{ id: "w1", label: "executor 1" }] });
		group.update("w1", { type: "turn", phase: "start" });
		assert.equal(b.sent.length, 0);
	});

	it("mirrors lanes of owned groups to the owner's bus, deduplicated", () => {
		process.env[PERCHO_SUBAGENT_RUNS_ENV] = "1";
		const owner = bus();
		const other = bus();
		registerPerchoBus("parent", owner.events);
		registerPerchoBus("someone-else", other.events);
		setFleetGroupOwner("g", "parent");
		const session = { sessionId: "child-1", sessionFile: "/x/child-1.jsonl" };
		const group = fleet.registerGroup({
			groupId: "g",
			role: "executor",
			modelLabel: "prov/model",
			lanes: [{ id: "w1", label: "executor 1", abort: () => {} }],
		});
		assert.equal(owner.sent.length, 1);
		assert.deepEqual(
			{ ...owner.sent[0]!.data, abort: typeof owner.sent[0]!.data.abort },
			{
				v: 1,
				type: "run",
				parentSessionId: "parent",
				runId: "g:w1",
				agent: "executor 1",
				status: "queued",
				model: "prov/model",
				abort: "function",
			},
		);
		assert.equal(owner.sent[0]!.channel, PERCHO_SUBAGENT_RUNS_CHANNEL);

		group.update("w1", { type: "session", session });
		const withSession = owner.sent.at(-1)!.data;
		assert.equal(withSession.session, session);
		assert.equal(withSession.status, "queued");

		group.update("w1", { type: "turn", phase: "start" });
		assert.equal(owner.sent.at(-1)!.data.status, "running");
		assert.equal(owner.sent.at(-1)!.data.task, "thinking");

		const before = owner.sent.length;
		group.update("w1", { type: "transcript", phase: "update", entryType: "assistant-text", key: "t", text: "a", update: "append", streaming: true });
		group.update("w1", { type: "transcript", phase: "update", entryType: "assistant-text", key: "t", text: "b", update: "append", streaming: true });
		// streaming text changes the phase once, then nothing new to say
		assert.ok(owner.sent.length <= before + 1);

		group.update("w1", { type: "usage", input: 100, output: 20 });
		assert.equal(owner.sent.at(-1)!.data.tokens, 120);

		group.setNote("w1", "2/5 tasks");
		assert.equal(owner.sent.at(-1)!.data.task, "2/5 tasks");

		group.complete("w1", { ok: true, output: "done", stderr: "", turns: 1 });
		assert.equal(owner.sent.at(-1)!.data.status, "done");
		assert.equal(other.sent.length, 0);
	});

	it("reports failures with a bounded error text", () => {
		process.env[PERCHO_SUBAGENT_RUNS_ENV] = "1";
		const owner = bus();
		registerPerchoBus("parent", owner.events);
		setFleetGroupOwner("g", "parent");
		const group = fleet.registerGroup({ groupId: "g", role: "reviewer", lanes: [{ id: "r1" }] });
		group.update("w1", { type: "turn", phase: "start" });
		group.complete("r1", { ok: false, output: "", stderr: "", turns: 0, errorMessage: "x".repeat(900) });
		const last = owner.sent.at(-1)!.data;
		assert.equal(last.status, "failed");
		assert.equal((last.error as string).length, 500);
	});

	it("ignores groups without an owner bus", () => {
		process.env[PERCHO_SUBAGENT_RUNS_ENV] = "1";
		const owner = bus();
		registerPerchoBus("parent", owner.events);
		setFleetGroupOwner("g", "unknown-session");
		fleet.registerGroup({ groupId: "g", role: "executor", lanes: [{ id: "w1" }] });
		assert.equal(owner.sent.length, 0);
	});

	it("uses Percho's project slug rule", () => {
		assert.equal(projectSlug("/Users/a/工作/my proj"), "Users-a-my-proj");
		assert.equal(projectSlug("///"), "default");
	});
});
