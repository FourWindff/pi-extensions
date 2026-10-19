/**
 * Behaviour tests for the mode policy: given a mode and a tool call, is it
 * allowed or blocked and why; given mode file text, what comes out.
 *
 * Run with `node --test policy.test.ts` (Node 24 strips the types itself).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
	ALLOWED_SUBAGENTS,
	type Mode,
	type ToolCallInput,
	guardToolCall,
	isPlanFilePath,
	isSafeBashCommand,
	nextMode,
	isRestorableEntry,
	parseModeFile,
	resolveToolApply,
	resolveTools,
} from "./policy.ts";

const CWD = "/repo";

function blockReason(mode: Mode, call: ToolCallInput): string {
	const decision = guardToolCall(mode, CWD, call);
	if (!decision.block) throw new Error(`expected ${mode}/${call.toolName} to be blocked`);
	return decision.reason;
}

test("mode cycle is build → plan → ask → build and nothing else", () => {
	assert.equal(nextMode("build"), "plan");
	assert.equal(nextMode("plan"), "ask");
	assert.equal(nextMode("ask"), "build");
	assert.equal(nextMode(nextMode(nextMode("build"))), "build");
});

test("mode files parse comma and bracket tool lists the same way", () => {
	const comma = parseModeFile("---\nname: plan\ntools: read, grep\n---\nbody\n");
	const bracket = parseModeFile("---\nname: plan\ntools: [read, grep]\n---\nbody\n");
	assert.deepEqual(comma, bracket);
	assert.deepEqual(comma, { name: "plan", tools: ["read", "grep"], body: "body" });
});

test("missing tools means no tools, missing name means invalid file", () => {
	assert.deepEqual(parseModeFile("---\nname: ask\n---\nbody")?.tools, []);
	assert.equal(parseModeFile("---\ntools: read\n---\nbody"), undefined);
	assert.equal(parseModeFile("plain text without frontmatter"), undefined);
});

test("read-only bash is allowed, write-capable bash is not", () => {
	for (const command of ["rg TODO src", "ls -la", "git log --oneline -5", "git show HEAD", "cat package.json"]) {
		assert.equal(isSafeBashCommand(command), true, command);
	}
	for (const command of [
		"rm -rf build",
		"git push",
		"echo hi > out.txt",
		"rg TODO | tee out.txt",
		"mkdir -p a/b",
		"npm install",
		"sort in.txt -o out.txt",
		"curl -o page.html https://example.com",
		"find src -delete",
	]) {
		assert.equal(isSafeBashCommand(command), false, command);
	}
});

test("plan bash is unguarded, ask bash demands a known read-only shape", () => {
	for (const command of [
		"rm -rf build",
		"git commit -m x",
		"git push",
		"npm install",
		"git rev-parse HEAD",
		"cd src && git log",
		"echo hi > out.txt",
	]) {
		assert.deepEqual(guardToolCall("plan", CWD, { toolName: "bash", input: { command } }), { block: false }, command);
	}
	for (const command of ["git rev-parse HEAD", "git blame src/x.ts", "git fetch", "git worktree list", "cd src && git log"]) {
		assert.match(blockReason("ask", { toolName: "bash", input: { command } }), /shift\+tab/, command);
	}
	for (const command of ["rm -rf build", "git commit -m x", "npm install", "echo hi > out.txt"]) {
		assert.match(blockReason("ask", { toolName: "bash", input: { command } }), /shift\+tab/, command);
	}
});

test("plan files are confined to <cwd>/.pi/plans/*.md", () => {
	assert.equal(isPlanFilePath(CWD, ".pi/plans/x.md"), true);
	assert.equal(isPlanFilePath(CWD, "/repo/.pi/plans/x.md"), true);
	for (const path of ["src/x.ts", ".pi/plans/x.ts", "../plans/x.md", "/etc/passwd", ".pi/plans", ".pi/plans/"]) {
		assert.equal(isPlanFilePath(CWD, path), false, path);
	}
});

test("whitelist drops unregistered tools, snapshot restores in original order", () => {
	assert.deepEqual(
		resolveTools({ mode: "plan", whitelist: ["read", "not-installed", "write"], registered: ["write", "read"], snapshot: [] }),
		["read", "write"],
	);
	assert.deepEqual(resolveTools({ mode: "build", whitelist: [], registered: [], snapshot: ["write", "read", "bash"] }), [
		"write",
		"read",
		"bash",
	]);
});

test("build mode guards nothing", () => {
	assert.deepEqual(guardToolCall("build", CWD, { toolName: "bash", input: { command: "rm -rf /" } }), { block: false });
	assert.deepEqual(guardToolCall("build", CWD, { toolName: "write", input: { path: "src/x.ts" } }), { block: false });
});

test("read-only modes dispatch only the explore subagent", () => {
	for (const mode of ["plan", "ask"] as const) {
		assert.deepEqual(
			guardToolCall(mode, CWD, { toolName: "subagent", input: { agent: "explore", task: "map the ipc layer" } }),
			{ block: false },
		);
		assert.match(blockReason(mode, { toolName: "subagent", input: { agent: "general", task: "refactor" } }), /explore/);
		assert.match(blockReason(mode, { toolName: "subagent", input: { agent: "general", task: "refactor" } }), /shift\+tab/);
	}

	// One bad agent blocks the whole parallel call; unknown agents are not a way in.
	assert.match(
		blockReason("plan", {
			toolName: "subagent",
			input: { tasks: [{ agent: "explore", task: "a" }, { agent: "general", task: "b" }] },
		}),
		/general/,
	);
	assert.match(blockReason("plan", { toolName: "subagent", input: { task: "a" } }), /plan mode/);

	assert.deepEqual(
		guardToolCall("plan", CWD, {
			toolName: "subagent",
			input: { tasks: [{ agent: "explore", task: "a" }, { agent: "explore", task: "b" }] },
		}),
		{ block: false },
	);
	assert.deepEqual(guardToolCall("build", CWD, { toolName: "subagent", input: { agent: "general", task: "x" } }), {
		block: false,
	});
});

test("plan mode writes plan files and blocks everything else", () => {
	assert.deepEqual(guardToolCall("plan", CWD, { toolName: "write", input: { path: ".pi/plans/demo.md" } }), { block: false });
	assert.deepEqual(guardToolCall("plan", CWD, { toolName: "edit", input: { path: "/repo/.pi/plans/demo.md" } }), { block: false });
	assert.match(blockReason("plan", { toolName: "write", input: { path: "src/x.ts" } }), /\.pi\/plans/);
});

test("ask mode lets reads through and blocks writes even mid-flight", () => {
	assert.deepEqual(guardToolCall("ask", CWD, { toolName: "bash", input: { command: "rg TODO" } }), { block: false });
	assert.deepEqual(guardToolCall("ask", CWD, { toolName: "read", input: { path: "src/x.ts" } }), { block: false });
	assert.match(blockReason("ask", { toolName: "write", input: { path: ".pi/plans/demo.md" } }), /ask mode/);
	assert.match(blockReason("ask", { toolName: "edit", input: { path: "src/x.ts" } }), /shift\+tab/);
});

test("the explore agent is read-only, and is the only agent named for the read-only modes", () => {
	const explore = parseModeFile(readFileSync(new URL("../../agents/explore.md", import.meta.url), "utf8"));
	assert.ok(explore, "explore.md must parse");
	assert.equal(explore.name, "explore");
	assert.deepEqual(explore.tools, ["read", "grep", "find", "ls"]);
	for (const writeCapable of ["bash", "write", "edit"]) {
		assert.ok(!explore.tools.includes(writeCapable), `explore must not have ${writeCapable}`);
	}
	for (const mode of ["plan", "ask"] as const) {
		assert.deepEqual(ALLOWED_SUBAGENTS[mode], ["explore"], `${mode} may dispatch only explore`);
	}

	// Both read-only modes need the tool, or the whitelist above guards nothing.
	for (const file of ["plan.md", "ask.md"]) {
		const mode = parseModeFile(readFileSync(new URL(file, import.meta.url), "utf8"));
		assert.ok(mode?.tools.includes("subagent"), `${file} needs the subagent tool`);
	}
});

test("a tool set that did not take effect is retried without names the runtime no longer knows", () => {
	const registered = ["read", "bash", "edit", "mcp"];
	// Everything asked for is active: nothing to report.
	assert.deepEqual(resolveToolApply({ requested: ["read", "bash"], applied: ["read", "bash"], registered }), {
		unresolved: [],
	});
	// Names the runtime does not know are dropped silently by design, never "lost".
	assert.deepEqual(resolveToolApply({ requested: ["read", "gone"], applied: ["read"], registered }), { unresolved: [] });
	// One stale name poisons the whole call: resend without it.
	assert.deepEqual(resolveToolApply({ requested: ["read", "edit", "mcpScript"], applied: ["read", "bash"], registered }), {
		retry: ["read", "edit"],
	});
	// Nothing stale to blame, yet a registered tool stayed missing: report it.
	assert.deepEqual(resolveToolApply({ requested: ["read", "edit"], applied: ["read"], registered }), {
		unresolved: ["edit"],
	});
	// Extra active tools are not this call's business.
	assert.deepEqual(resolveToolApply({ requested: ["read"], applied: ["read", "bash"], registered }), { unresolved: [] });
});

test("only a settled tool snapshot makes a stored mode restorable", () => {
	const snapshot = ["read", "bash", "edit"];
	assert.equal(isRestorableEntry({ mode: "plan", toolsBeforeMode: snapshot, toolsSettled: true }), true);
	// Written before snapshots carried a provenance flag: the one that was taken
	// seconds after launch and came back missing tools.
	assert.equal(isRestorableEntry({ mode: "plan", toolsBeforeMode: snapshot }), false);
	for (const data of [
		undefined,
		{ mode: "build", toolsBeforeMode: snapshot, toolsSettled: true },
		{ mode: "plan", toolsSettled: true },
		{ mode: "plan", toolsBeforeMode: ["read", 7], toolsSettled: true },
		{ mode: "nonsense", toolsBeforeMode: snapshot, toolsSettled: true },
	]) {
		assert.equal(isRestorableEntry(data), false, JSON.stringify(data));
	}
});

test("shipped mode files parse and keep the write tools out of ask", () => {
	const plan = parseModeFile(readFileSync(new URL("plan.md", import.meta.url), "utf8"));
	const ask = parseModeFile(readFileSync(new URL("ask.md", import.meta.url), "utf8"));
	assert.ok(plan, "plan.md must parse");
	assert.ok(ask, "ask.md must parse");
	assert.ok(plan.tools.includes("write") && plan.tools.includes("edit"), "plan mode needs the plan file tools");
	// The ask-user extension registers ask_user; a mode only gets it when its
	// whitelist carries the name. (build has no file; it keeps the full
	// registered set, question tool included.)
	assert.ok(plan.tools.includes("ask_user"), "plan mode needs the question tool");
	assert.ok(ask.tools.includes("ask_user"), "ask mode needs the question tool");
	assert.ok(!ask.tools.includes("write") && !ask.tools.includes("edit"), "ask mode must not have write tools");
	assert.ok(!plan.tools.includes("mcp") && !ask.tools.includes("mcp"), "MCP would be a backdoor around every guard");
});
