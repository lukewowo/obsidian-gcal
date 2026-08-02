// Minimal stand-in for the parts of the `obsidian` module that the pure-logic
// modules (dates.ts, query.ts) use, so they can run under plain node.
//
// `require` rather than `import`: both moment and js-yaml are CommonJS exports
// of a callable value, and an ESM namespace import wraps them in an object.

export const moment = require("moment") as typeof import("moment");

const yaml = require("js-yaml") as { load: (source: string) => unknown };

export function parseYaml(source: string): unknown {
	return yaml.load(source);
}

export function requestUrl(): never {
	throw new Error("requestUrl is not available in the test shim");
}

// Enough of the vault surface for the pure helpers in notes.ts to import cleanly.
// Nothing under test constructs these; they exist for `instanceof` checks.
export class TAbstractFile {}
export class TFile extends TAbstractFile {}
export class TFolder extends TAbstractFile {}

export class Notice {
	constructor(readonly message: string, readonly timeout?: number) {}
}

export function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "") || "/";
}
