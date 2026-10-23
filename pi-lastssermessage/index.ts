import type { UserMessage } from "@earendil-works/pi-ai";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Show the latest submitted user message on the editor's top border. */
export default function lastUserMessage(pi: ExtensionAPI): void {
	let preview = "";
	let requestRender: (() => void) | undefined;

	function setMessage(message: UserMessage): void {
		const text = typeof message.content === "string"
			? message.content
			: message.content.map((block) => block.type === "text" ? block.text : "[image]").join(" ");
		preview = stripTerminalSequences(text)
			.replace(/\s+/g, " ")
			.replace(/[\x00-\x1f\x7f-\x9f]/g, "")
			.trim();
		requestRender?.();
	}

	function restore(ctx: ExtensionContext): void {
		preview = "";
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i]!;
			if (entry.type === "message" && entry.message.role === "user") {
				setMessage(entry.message);
				return;
			}
		}
		requestRender?.();
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		restore(ctx);
		const inner = ctx.ui.getEditorComponent();
		// Wrap once: mode-switching can wrap this factory without stacking a new preview each turn.
		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			requestRender = () => tui.requestRender();
			const component = inner
				? inner(tui, theme, keybindings)
				: new CustomEditor(tui, theme, keybindings, { embedWorkingStatus: true });
			const editor = component as typeof component & {
				renderTopBorder?: (width: number, hiddenLines: number) => string;
				borderColor?: (text: string) => string;
			};
			const renderTopBorder = editor.renderTopBorder?.bind(editor);
			if (renderTopBorder) {
				editor.renderTopBorder = (width, hiddenLines) => {
					// Reserve 40 columns for native status; the right cap mirrors its two-dash prefix.
					const previewWidth = Math.min(40, width - 44);
					if (!preview || previewWidth < 8) return renderTopBorder(width, hiddenLines);
					const text = truncateToWidth(preview, previewWidth, "…");
					const borderColor = editor.borderColor ?? theme.borderColor;
					return renderTopBorder(width - previewWidth - 4, hiddenLines)
						+ borderColor("─".repeat(previewWidth - visibleWidth(text)) + " ")
						+ ctx.ui.theme.fg("dim", text)
						+ borderColor(" ──");
				};
			}
			return component;
		});
	});

	pi.on("message_start", (event, ctx) => {
		if (ctx.mode === "tui" && event.message.role === "user") setMessage(event.message);
	});
	pi.on("session_tree", (_event, ctx) => {
		if (ctx.mode === "tui") restore(ctx);
	});
	pi.on("session_shutdown", () => {
		requestRender = undefined;
	});
}
