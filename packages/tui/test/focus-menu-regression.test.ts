import { describe, expect, it } from "bun:test";
import { type Component, CURSOR_MARKER, type Focusable, TUI } from "@oh-my-pi/pi-tui";
import { VirtualRenderScheduler } from "./virtual-render-scheduler";
import { VirtualTerminal } from "./virtual-terminal";

class FocusToken implements Component, Focusable {
	focused = false;

	invalidate(): void {}

	render(): string[] {
		return [];
	}
}

class MenuFrame implements Component {
	working = false;
	menuOpen = false;
	#editor: FocusToken;
	#menu: FocusToken;

	constructor(editor: FocusToken, menu: FocusToken) {
		this.#editor = editor;
		this.#menu = menu;
	}

	invalidate(): void {}

	render(): string[] {
		const lines = ["assistant"];
		if (this.working) lines.push(": Working... <esc>");
		if (this.menuOpen) {
			for (let i = 0; i < 12; i++) {
				lines.push(`menu-${i}${this.#menu.focused && i === 11 ? CURSOR_MARKER : ""}`);
			}
		}
		lines.push(`prompt${this.#editor.focused ? CURSOR_MARKER : ""}`);
		return lines;
	}
}

describe("focus-changing menu teardown", () => {
	it("repaints stale menu and working rows on ED3-risk terminals without a viewport oracle", async () => {
		const term = new VirtualTerminal(30, 6, 1000);
		// Frames run on a virtual clock: on the real one, a loaded machine paints
		// the last frame after a fixed sleep has already given up waiting for it.
		const scheduler = new VirtualRenderScheduler();
		const tui = new TUI(term, true, { renderScheduler: scheduler });
		const editor = new FocusToken();
		const menu = new FocusToken();
		const frame = new MenuFrame(editor, menu);
		tui.addChild(frame);
		tui.setFocus(editor);

		try {
			tui.start();
			await scheduler.settle(term);

			frame.working = true;
			tui.requestRender();
			await scheduler.settle(term);

			frame.menuOpen = true;
			tui.setFocus(menu);
			tui.requestRender();
			await scheduler.settle(term);

			frame.working = false;
			tui.requestRender();
			await scheduler.settle(term);
			// The menu is on screen, so the close below has rows to repaint: the
			// last frame looks like the first one, so the final check alone
			// would also pass if no frame after the first had been painted.
			expect(term.getViewport().map(line => line.trimEnd())).toContain("menu-11");

			frame.menuOpen = false;
			tui.setFocus(editor);
			tui.requestRender();
			await scheduler.settle(term);

			// The menu rows were committed to history while the menu was tall;
			// closing it resyncs the commit index at the divergence (stale menu
			// stays in scrollback). The focused cursor tail is shorter than the
			// viewport, so the window re-anchors at the frame tail instead of
			// pinning "prompt" at the top with blank rows underneath —
			// "assistant" is re-shown on the grid (its committed copy stays in
			// scrollback; duplication, never loss).
			expect(term.getViewport().map(line => line.trimEnd())).toEqual(["assistant", "prompt", "", "", "", ""]);
			expect(term.getCursor()).toEqual({ row: 1, col: 6 });
		} finally {
			tui.stop();
		}
	});
});
