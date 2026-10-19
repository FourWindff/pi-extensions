/**
 * Skill Rider storage and text building.
 *
 * A rider is one extra prompt per skill, kept in a JSON file next to pi's
 * settings. Skill files are only ever read, never written: the rider is
 * injected at load time instead.
 *
 * This module stays free of pi imports so it can be tested with node directly.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface RiderStore {
	version: 1;
	riders: Record<string, string>;
}

/** The parts of a skill needed to rebuild the block pi puts into the prompt. */
export interface SkillRef {
	name: string;
	filePath: string;
	baseDir: string;
}

/** Read the store; a missing, unreadable, or malformed file reads as empty. */
export function readRiderStore(storePath: string): RiderStore {
	try {
		const parsed: unknown = JSON.parse(readFileSync(storePath, "utf-8"));
		const riders = (parsed as { riders?: unknown } | null)?.riders;
		if (riders && typeof riders === "object" && !Array.isArray(riders)) {
			const clean: Record<string, string> = {};
			for (const [name, text] of Object.entries(riders)) {
				if (typeof text === "string") clean[name] = text;
			}
			return { version: 1, riders: clean };
		}
	} catch {
		// Missing or unreadable store: start empty.
	}
	return { version: 1, riders: {} };
}

/** Write the store, dropping empty riders so the file only lists real ones. */
export function writeRiderStore(storePath: string, store: RiderStore): void {
	const riders: Record<string, string> = {};
	for (const [name, text] of Object.entries(store.riders)) {
		if (text.trim() !== "") riders[name] = text;
	}
	mkdirSync(dirname(storePath), { recursive: true });
	// Write through a temp file so an interrupted save cannot truncate the store.
	const tempPath = `${storePath}.tmp`;
	writeFileSync(tempPath, `${JSON.stringify({ version: 1, riders }, null, 2)}\n`, "utf-8");
	renameSync(tempPath, storePath);
}

/** The skill block pi writes for `/skill:<name>`, byte for byte. */
export function formatSkillBlock(skill: SkillRef, body: string): string {
	return `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
}

/**
 * The text a `/skill:<name>` input expands to: the skill block, then the rider
 * as its own block, then the user's arguments.
 */
export function expandSkillWithRider(skill: SkillRef, body: string, rider: string, args: string): string {
	const parts = [formatSkillBlock(skill, body), rider.trim()];
	if (args !== "") parts.push(args);
	return parts.join("\n\n");
}
