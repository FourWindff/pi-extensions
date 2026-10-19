/**
 * Behaviour tests for skill rider storage and text building.
 *
 * Run with `node --test riders.test.ts` (Node 24 strips the types itself).
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { expandSkillWithRider, readRiderStore, writeRiderStore, type SkillRef } from "./riders.ts";

const skill: SkillRef = { name: "demo", filePath: "/skills/demo/SKILL.md", baseDir: "/skills/demo" };
const storePath = () => join(mkdtempSync(join(tmpdir(), "skill-rider-")), "skill-riders.json");

test("store round-trips riders and drops empty ones", () => {
	const path = storePath();
	writeRiderStore(path, { version: 1, riders: { demo: "be brief", other: "   " } });
	assert.deepEqual(readRiderStore(path).riders, { demo: "be brief" });
});

test("a missing or malformed store reads as empty", () => {
	const path = storePath();
	assert.deepEqual(readRiderStore(path).riders, {});

	writeFileSync(path, "{ not json");
	assert.deepEqual(readRiderStore(path).riders, {});

	writeFileSync(path, JSON.stringify({ riders: { demo: 42 } }));
	assert.deepEqual(readRiderStore(path).riders, {});
});

test("expansion puts the rider between the skill block and the user's arguments", () => {
	const body = "# Demo\n\nDo the thing.";
	const text = expandSkillWithRider(skill, body, "Always answer in haiku.", "on the docs folder");
	assert.equal(
		text,
		'<skill name="demo" location="/skills/demo/SKILL.md">\nReferences are relative to /skills/demo.\n\n' +
			"# Demo\n\nDo the thing.\n</skill>\n\nAlways answer in haiku.\n\non the docs folder",
	);
	assert.ok(text.includes(body), "the skill body reaches the model unchanged");
});

test("arguments are optional", () => {
	assert.equal(
		expandSkillWithRider(skill, "body", "rider", ""),
		'<skill name="demo" location="/skills/demo/SKILL.md">\nReferences are relative to /skills/demo.\n\nbody\n</skill>\n\nrider',
	);
});

test("writing never touches the skill file", () => {
	const path = storePath();
	const skillFile = join(path, "..", "SKILL.md");
	writeFileSync(skillFile, "original");
	writeRiderStore(path, { version: 1, riders: { demo: "rider" } });
	assert.equal(readFileSync(skillFile, "utf-8"), "original");
});
