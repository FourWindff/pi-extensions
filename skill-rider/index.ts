/**
 * Skill Rider — one extra prompt per skill, added without touching the skill.
 *
 * A rider is stored in `<agent dir>/skill-riders.json` keyed by skill name.
 * Skill files are only read. When a skill is invoked with `/skill:<name>`, the
 * rider is appended after the skill block as its own block in the transcript;
 * when the model reads a `SKILL.md` itself, the rider is appended to that read.
 *
 * `/skill-rider` opens the panel for viewing and editing riders.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getAgentDir, stripFrontmatter, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { RiderPanel } from "./panel.ts";
import { expandSkillWithRider, readRiderStore, writeRiderStore, type SkillRef } from "./riders.ts";

export default function skillRider(pi: ExtensionAPI) {
	const storePath = join(getAgentDir(), "skill-riders.json");

	function riders(): Record<string, string> {
		return readRiderStore(storePath).riders;
	}

	function save(name: string, text: string): void {
		const store = readRiderStore(storePath);
		if (text.trim() === "") delete store.riders[name];
		else store.riders[name] = text;
		writeRiderStore(storePath, store);
	}

	/** Every skill pi actually loaded, from the same list `/skill:` commands come from. */
	function skills(): SkillRef[] {
		return pi
			.getCommands()
			.filter((command) => command.source === "skill")
			.map((command) => ({
				name: command.name.slice("skill:".length),
				filePath: command.sourceInfo.path,
				baseDir: dirname(command.sourceInfo.path),
			}))
			.filter((skill) => !skill.filePath.startsWith("<"))
			.sort((a, b) => a.name.localeCompare(b.name));
	}

	function skillBody(skill: SkillRef): string | undefined {
		try {
			return stripFrontmatter(readFileSync(skill.filePath, "utf-8")).trim();
		} catch {
			return undefined;
		}
	}

	// `/skill:<name> args` expands to the skill block, the rider, then the args.
	// Pi renders the part after the block as its own transcript block.
	pi.on("input", (event) => {
		const prefix = "/skill:";
		if (!event.text.startsWith(prefix)) return;
		const spaceIndex = event.text.indexOf(" ");
		const name = spaceIndex === -1 ? event.text.slice(prefix.length) : event.text.slice(prefix.length, spaceIndex);
		const args = spaceIndex === -1 ? "" : event.text.slice(spaceIndex + 1).trim();

		const rider = riders()[name];
		if (rider === undefined || rider.trim() === "") return;

		const skill = skills().find((candidate) => candidate.name === name);
		if (!skill) return;
		const body = skillBody(skill);
		if (body === undefined) return;

		return { action: "transform", text: expandSkillWithRider(skill, body, rider, args) };
	});

	// A skill the model loads on its own: append the rider to the read result.
	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "read" || event.isError) return;
		const requested = event.input.path;
		if (typeof requested !== "string") return;

		const absolute = resolve(expandHome(requested));
		const skill = skills().find((candidate) => resolve(expandHome(candidate.filePath)) === absolute);
		if (!skill) return;
		const rider = riders()[skill.name];
		if (rider === undefined || rider.trim() === "") return;

		const index = event.content.map((block) => block.type).lastIndexOf("text");
		if (index === -1) return;
		const block = event.content[index];
		if (block?.type !== "text") return;

		const content = [...event.content];
		content[index] = { type: "text", text: `${block.text}\n\n${rider.trim()}` };
		return { content };
	});

	pi.registerCommand("skill-rider", {
		description: "Add an extra prompt to a skill (the skill's own files are not changed)",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("skill-rider needs the interactive terminal UI", "warning");
				return;
			}
			const list = skills();
			if (list.length === 0) {
				ctx.ui.notify("No skills loaded", "warning");
				return;
			}
			await ctx.ui.custom<undefined>(
				(tui, theme, _keybindings, done) =>
					new RiderPanel(tui, theme, {
						skills: list.map((skill) => ({ name: skill.name })),
						riders: riders(),
						skillBody: (name) => {
							const skill = list.find((candidate) => candidate.name === name);
							return skill ? skillBody(skill) : undefined;
						},
						save,
						done: () => done(undefined),
					}),
				{ overlay: true, overlayOptions: { width: "85%", minWidth: 60, maxHeight: "90%", anchor: "center" } },
			);
		},
	});
}

/** `~` is only expanded here; the read tool's own path rules stay pi's business. */
function expandHome(path: string): string {
	return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}
