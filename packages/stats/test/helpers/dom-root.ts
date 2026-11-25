/**
 * A React root for the dashboard's client tests, on a page that stands in for
 * the browser: {@link mountDomRoot} makes a fresh page's `window`, `document`
 * and DOM classes the process's globals and mounts a root on its `#root`, and
 * {@link tearDownDomRoot}, which each test file runs after each test, unmounts
 * that root and gives each global it replaced its own value back.
 */
import { parseHTML } from "@oh-my-pi/pi-utils/dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

/** The DOM classes React and the dashboard's components test nodes against, taken from the page's window. */
const DOM_CLASSES = ["Node", "Element", "HTMLElement", "HTMLIFrameElement", "SVGElement"] as const;

/** Each global replaced since the last tear-down, with the descriptor the process had before the first replacement. */
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
let mountedRoot: Root | undefined;

/** Sets the global `name` to `value` until the next {@link tearDownDomRoot}. */
export function installGlobal(name: string, value: unknown): void {
	if (!originalGlobals.has(name)) originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
	Object.defineProperty(globalThis, name, { configurable: true, value, writable: true });
}

/** Unmounts the root {@link mountDomRoot} mounted last, if it is still mounted. */
async function unmountRoot(): Promise<void> {
	const root = mountedRoot;
	if (!root) return;
	mountedRoot = undefined;
	await act(async () => {
		root.unmount();
	});
}

/** Makes a fresh page the process's DOM and mounts a React root on its `#root`, after unmounting an earlier one. */
export async function mountDomRoot(): Promise<Root> {
	await unmountRoot();
	const domWindow = parseHTML('<html><body><div id="root"></div></body></html>').window;
	// A component that sets or clears a timer through `window` (JsonBlock's "Copied") gets the process's.
	Object.assign(domWindow, { setTimeout, clearTimeout });
	installGlobal("window", domWindow);
	installGlobal("document", domWindow.document);
	installGlobal("navigator", domWindow.navigator);
	for (const name of DOM_CLASSES) installGlobal(name, domWindow[name]);
	installGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	const container = domWindow.document.getElementById("root");
	if (!container) throw new Error("Expected test root");
	mountedRoot = createRoot(container as unknown as Element);
	return mountedRoot;
}

/** Unmounts the mounted root and gives every global replaced since the last tear-down the value the process had. */
export async function tearDownDomRoot(): Promise<void> {
	await unmountRoot();
	for (const [name, descriptor] of originalGlobals) {
		if (descriptor) Object.defineProperty(globalThis, name, descriptor);
		else Reflect.deleteProperty(globalThis, name);
	}
	originalGlobals.clear();
}
