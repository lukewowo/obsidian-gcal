import { Notice, TFile, TFolder, normalizePath, type App } from "obsidian";
import { formatDuration, formatTime, timeLabel } from "./dates";
import type { GCalSettings, NoteType } from "./settings";
import type { CalEvent } from "./types";

/** Frontmatter key that ties a note back to its calendar event. */
export const EVENT_ID_KEY = "event-id";

export class NoteError extends Error {}

// --- Third-party plugin surfaces -----------------------------------------
// Neither API is in the Obsidian typings, so they are declared narrowly here
// and every call site treats them as possibly absent.

interface TemplaterPlugin {
	settings?: { templates_folder?: string };
	templater?: {
		create_new_note_from_template?: (
			template: TFile | string,
			folder?: TFolder | string,
			filename?: string,
			openNewNote?: boolean
		) => Promise<TFile | undefined>;
		overwrite_file_commands?: (file: TFile, activeFile?: boolean) => Promise<void>;
	};
}

interface QuickAddChoiceRaw {
	id?: string;
	name?: string;
	/** "Template" | "Capture" | "Macro" | "Multi" */
	type?: string;
	/** Present on Multi choices, which are folders rather than something to run. */
	choices?: QuickAddChoiceRaw[];
}

interface QuickAddPlugin {
	api?: {
		executeChoice?: (choiceName: string, variables?: Record<string, unknown>) => Promise<void>;
	};
	settings?: {
		choices?: QuickAddChoiceRaw[];
		templateFolderPath?: string;
	};
}

function getPlugin<T>(app: App, id: string): T | null {
	const registry = (app as unknown as { plugins?: { plugins?: Record<string, unknown> } }).plugins;
	return (registry?.plugins?.[id] as T | undefined) ?? null;
}

export function templaterAvailable(app: App): boolean {
	return Boolean(getPlugin<TemplaterPlugin>(app, "templater-obsidian")?.templater);
}

export function quickAddAvailable(app: App): boolean {
	return Boolean(getPlugin<QuickAddPlugin>(app, "quickadd")?.api?.executeChoice);
}

export interface QuickAddChoiceInfo {
	/** The name `executeChoice` resolves by. */
	name: string;
	/** Name prefixed with its Multi ancestors, for display only. */
	label: string;
	type: string;
}

/**
 * Every runnable QuickAdd choice, so the settings tab can offer a list instead of
 * asking the user to retype a name. Multi choices are folders rather than actions,
 * so they are walked into but not offered.
 */
export function quickAddChoices(app: App): QuickAddChoiceInfo[] {
	const found: QuickAddChoiceInfo[] = [];

	const walk = (choices: QuickAddChoiceRaw[] | undefined, trail: string[]): void => {
		for (const choice of choices ?? []) {
			if (!choice?.name) continue;
			if (choice.type === "Multi") {
				walk(choice.choices, [...trail, choice.name]);
				continue;
			}
			found.push({
				name: choice.name,
				label: [...trail, choice.name].join(" / "),
				type: choice.type ?? "",
			});
		}
	};
	walk(getPlugin<QuickAddPlugin>(app, "quickadd")?.settings?.choices, []);

	// QuickAdd resolves by name alone, so a duplicate name is genuinely ambiguous
	// there too — flag it rather than silently offering two identical entries.
	const counts = new Map<string, number>();
	for (const choice of found) counts.set(choice.name, (counts.get(choice.name) ?? 0) + 1);
	for (const choice of found) {
		if ((counts.get(choice.name) ?? 0) > 1) choice.label = `${choice.label}  ⚠ duplicate name`;
	}

	return found.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Markdown files in whichever template folders the installed plugins are configured
 * with. Used to populate a picker; the path field stays editable for anything else.
 */
export function templateCandidates(app: App): string[] {
	const folders = new Set<string>();
	const templater = getPlugin<TemplaterPlugin>(app, "templater-obsidian")?.settings?.templates_folder;
	const quickadd = getPlugin<QuickAddPlugin>(app, "quickadd")?.settings?.templateFolderPath;
	const core = (
		app as unknown as {
			internalPlugins?: { plugins?: Record<string, { instance?: { options?: { folder?: string } } }> };
		}
	).internalPlugins?.plugins?.templates?.instance?.options?.folder;

	for (const folder of [templater, quickadd, core]) {
		if (folder && folder.trim()) folders.add(normalizePath(folder.trim()));
	}
	if (folders.size === 0) return [];

	const prefixes = [...folders].map((folder) => `${folder}/`);
	return app.vault
		.getMarkdownFiles()
		.map((file) => file.path)
		.filter((path) => prefixes.some((prefix) => path.startsWith(prefix)))
		.sort((a, b) => a.localeCompare(b));
}

// --- Placeholders ---------------------------------------------------------

const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z-]+)(?::([^}]*))?\s*\}\}/g;

function attendeeNames(event: CalEvent): string[] {
	return event.attendees
		.filter((attendee) => !attendee.resource)
		.map((attendee) => attendee.name ?? attendee.email ?? "unknown");
}

/**
 * Resolves one `{{key}}` or `{{key:format}}` placeholder.
 * Returns null for unknown keys so they can be left untouched — a template may
 * legitimately contain other plugins' placeholders.
 */
function placeholderValue(key: string, format: string | undefined, event: CalEvent, use24Hour: boolean): string | null {
	switch (key.toLowerCase()) {
		case "title":
			return event.title;
		case "id":
			return event.id;
		case "date":
			return event.start.format(format || "YYYY-MM-DD");
		case "time":
			return timeLabel(event, use24Hour);
		case "start":
			return format ? event.start.format(format) : event.allDay ? "all day" : formatTime(event.start, use24Hour);
		case "end":
			return format ? event.end.format(format) : event.allDay ? "" : formatTime(event.end, use24Hour);
		case "start-iso":
			return event.start.toISOString();
		case "end-iso":
			return event.end.toISOString();
		case "duration":
			return formatDuration(event.start, event.end, event.allDay);
		case "calendar":
			return event.calendarName;
		case "account":
			return event.accountLabel;
		case "location":
			return event.location ?? "";
		case "description":
			return event.description ?? "";
		case "organizer":
		case "organiser":
			return event.organizer ?? "";
		case "attendees":
			return attendeeNames(event).join(", ");
		case "attendees-list":
			return attendeeNames(event)
				.map((name) => `- ${name}`)
				.join("\n");
		case "link":
			return event.link ?? "";
		case "meet":
			return event.meetUrl ?? "";
		default:
			return null;
	}
}

export function substitute(text: string, event: CalEvent, use24Hour: boolean): string {
	return text.replace(PLACEHOLDER_RE, (whole, key: string, format?: string) => {
		const value = placeholderValue(key, format, event, use24Hour);
		return value === null ? whole : value;
	});
}

/** The same values as a flat map, for QuickAdd's `{{VALUE:name}}` syntax. */
export function placeholderMap(event: CalEvent, use24Hour: boolean): Record<string, string> {
	const keys = [
		"title",
		"id",
		"date",
		"time",
		"start",
		"end",
		"start-iso",
		"end-iso",
		"duration",
		"calendar",
		"account",
		"location",
		"description",
		"organizer",
		"attendees",
		"attendees-list",
		"link",
		"meet",
	];
	const values: Record<string, string> = {};
	for (const key of keys) values[key] = placeholderValue(key, undefined, event, use24Hour) ?? "";
	return values;
}

// --- Filesystem helpers ---------------------------------------------------

/** Obsidian rejects these outright, and `#^[]|` break wikilinks to the note. */
export function sanitiseSegment(name: string): string {
	return name
		.replace(/[\\/:*?"<>|#^[\]]/g, "-")
		.replace(/\s+/g, " ")
		.replace(/^\.+/, "")
		.trim()
		.slice(0, 180)
		.trim();
}

function sanitiseFilename(name: string): string {
	return sanitiseSegment(name) || "Meeting note";
}

/** Cleans each segment of a folder path, keeping the separators. */
export function sanitiseFolder(path: string): string {
	const cleaned = path
		.split("/")
		.map((segment) => sanitiseSegment(segment))
		.filter(Boolean)
		.join("/");
	return cleaned || "/";
}

async function ensureFolder(app: App, path: string): Promise<TFolder | undefined> {
	if (!path) return undefined;
	const existing = app.vault.getAbstractFileByPath(path);
	if (existing instanceof TFolder) return existing;
	if (existing) throw new NoteError(`"${path}" is a file, not a folder`);

	await app.vault.createFolder(path);
	const created = app.vault.getAbstractFileByPath(path);
	if (!(created instanceof TFolder)) throw new NoteError(`Could not create the folder "${path}"`);
	return created;
}

function defaultBody(event: CalEvent, use24Hour: boolean): string {
	const lines = [`# ${event.title}`, ""];

	lines.push(`**When:** ${event.start.format("dddd D MMMM YYYY")} · ${timeLabel(event, use24Hour)}`);
	if (event.location) lines.push(`**Where:** ${event.location}`);

	const guests = attendeeNames(event);
	if (guests.length) lines.push(`**Attendees:** ${guests.join(", ")}`);
	if (event.meetUrl) lines.push(`**Call:** ${event.meetUrl}`);
	if (event.link) lines.push(`[Open in Google Calendar](${event.link})`);

	lines.push("", "## Notes", "", "", "## Actions", "", "- [ ] ");
	return lines.join("\n");
}

// --- Note creation --------------------------------------------------------

export interface NoteTarget {
	type: NoteType;
	path: string | null;
	existing: TFile | null;
}

export class MeetingNotes {
	/**
	 * The event whose note is currently being created. Templater renders its template
	 * before we can touch the file, so this is the only way a Templater-mode template
	 * can reach event data — see the README.
	 */
	lastEvent: CalEvent | null = null;

	/** Lazily built map of event id → note path, invalidated on vault changes. */
	private index: Map<string, string> | null = null;

	constructor(
		private readonly app: App,
		private readonly getSettings: () => GCalSettings
	) {}

	invalidateIndex(): void {
		this.index = null;
	}

	private getIndex(): Map<string, string> {
		if (this.index) return this.index;
		const map = new Map<string, string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const id = this.app.metadataCache.getFileCache(file)?.frontmatter?.[EVENT_ID_KEY];
			if (typeof id === "string" && id && !map.has(id)) map.set(id, file.path);
		}
		this.index = map;
		return map;
	}

	types(): NoteType[] {
		return this.getSettings().noteTypes;
	}

	hasType(name: string): boolean {
		const needle = name.trim().toLowerCase();
		return this.types().some((type) => type.id === name || type.name.toLowerCase() === needle);
	}

	/**
	 * Picks the note type to use. With nothing configured this returns a synthetic
	 * built-in type, so creating a note works before the user sets anything up.
	 */
	resolveType(name?: string): NoteType {
		const settings = this.getSettings();
		const configured = settings.noteTypes;

		if (name) {
			const needle = name.trim().toLowerCase();
			const found = configured.find(
				(type) => type.id === name || type.name.toLowerCase() === needle
			);
			if (!found) {
				const known = configured.map((type) => type.name).join(", ") || "none configured";
				throw new NoteError(`Unknown note type "${name}". Available: ${known}`);
			}
			return found;
		}

		const byDefault = configured.find(
			(type) => type.id === settings.defaultNoteType || type.name === settings.defaultNoteType
		);
		return (
			byDefault ??
			configured[0] ?? {
				id: "builtin",
				name: "Meeting note",
				mode: "builtin",
				openAfterCreate: true,
			}
		);
	}

	/**
	 * Block override beats the note type's folder, which beats the global default.
	 * Placeholders are resolved so `Meetings/{{date:YYYY}}` works.
	 */
	private folderFor(event: CalEvent, type: NoteType, override?: string): string {
		const raw = override?.trim() || type.folder?.trim() || this.getSettings().noteFolder.trim();
		if (!raw) return "/";
		const resolved = sanitiseFolder(substitute(raw, event, this.getSettings().use24HourTime));
		return resolved === "/" ? "/" : normalizePath(resolved);
	}

	private filenameFor(event: CalEvent, type: NoteType): string {
		const settings = this.getSettings();
		const format = type.filenameFormat?.trim() || settings.noteFilenameFormat;
		return sanitiseFilename(substitute(format, event, settings.use24HourTime));
	}

	/** Where a note for this event would live, and whether it is already there. */
	target(event: CalEvent, typeName?: string, folderOverride?: string): NoteTarget | null {
		let type: NoteType;
		try {
			type = this.resolveType(typeName);
		} catch {
			return null;
		}

		// QuickAdd owns its own naming, so there is no path to predict.
		const path =
			type.mode === "quickadd"
				? null
				: (() => {
						const folder = this.folderFor(event, type, folderOverride);
						const filename = this.filenameFor(event, type);
						return normalizePath(folder === "/" ? `${filename}.md` : `${folder}/${filename}.md`);
					})();

		let existing: TFile | null = null;
		if (path) {
			const atPath = this.app.vault.getAbstractFileByPath(path);
			if (atPath instanceof TFile) existing = atPath;
		}
		if (!existing) {
			// Catches notes the user has since renamed or moved.
			const indexed = this.getIndex().get(event.id);
			if (indexed) {
				const file = this.app.vault.getAbstractFileByPath(indexed);
				if (file instanceof TFile) existing = file;
			}
		}

		return { type, path, existing };
	}

	async open(file: TFile): Promise<void> {
		await this.app.workspace.getLeaf("tab").openFile(file);
	}

	/** Opens the event's note, creating it first if it does not exist yet. */
	async createOrOpen(event: CalEvent, typeName?: string, folderOverride?: string): Promise<void> {
		this.lastEvent = event;
		try {
			const type = this.resolveType(typeName);
			const target = this.target(event, typeName, folderOverride);

			if (target?.existing) {
				await this.open(target.existing);
				return;
			}

			switch (type.mode) {
				case "quickadd":
					await this.viaQuickAdd(event, type);
					break;
				case "templater":
					await this.viaTemplater(event, type, folderOverride);
					break;
				default:
					await this.viaBuiltin(event, type, target?.path ?? null, folderOverride);
			}
			this.invalidateIndex();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			new Notice(`Meeting note: ${message}`, 10000);
		}
	}

	private async viaBuiltin(event: CalEvent, type: NoteType, path: string | null, folderOverride?: string): Promise<void> {
		const settings = this.getSettings();
		const folder = this.folderFor(event, type, folderOverride);
		await ensureFolder(this.app, folder === "/" ? "" : folder);

		const target = path ?? normalizePath(folder === "/" ? `${this.filenameFor(event, type)}.md` : `${folder}/${this.filenameFor(event, type)}.md`);

		let content: string;
		if (type.templatePath) {
			const template = this.app.vault.getAbstractFileByPath(normalizePath(type.templatePath));
			if (!(template instanceof TFile)) throw new NoteError(`Template not found: ${type.templatePath}`);
			content = substitute(await this.app.vault.read(template), event, settings.use24HourTime);
		} else {
			content = defaultBody(event, settings.use24HourTime);
		}

		const file = await this.app.vault.create(target, content);

		// Templater runs first so it cannot overwrite the id we stamp below.
		if (settings.runTemplaterOnCreate) {
			const templater = getPlugin<TemplaterPlugin>(this.app, "templater-obsidian")?.templater;
			if (templater?.overwrite_file_commands) await templater.overwrite_file_commands(file);
		}

		await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
			frontmatter[EVENT_ID_KEY] = event.id;
			// Only fill the rest when there is no template; a template's own
			// frontmatter is the user's business.
			if (!type.templatePath) {
				frontmatter["event-title"] = event.title;
				frontmatter["event-start"] = event.start.toISOString();
				frontmatter["event-end"] = event.end.toISOString();
				frontmatter["event-calendar"] = event.calendarName;
				frontmatter["event-account"] = event.accountLabel;
				if (event.location) frontmatter["event-location"] = event.location;
				if (event.link) frontmatter["event-link"] = event.link;
			}
		});

		if (type.openAfterCreate) await this.open(file);
	}

	private async viaQuickAdd(event: CalEvent, type: NoteType): Promise<void> {
		const api = getPlugin<QuickAddPlugin>(this.app, "quickadd")?.api;
		if (!api?.executeChoice) throw new NoteError("QuickAdd is not installed or not enabled");
		if (!type.quickAddChoice) throw new NoteError(`Note type "${type.name}" has no QuickAdd choice set`);

		await api.executeChoice(type.quickAddChoice, placeholderMap(event, this.getSettings().use24HourTime));
	}

	private async viaTemplater(event: CalEvent, type: NoteType, folderOverride?: string): Promise<void> {
		const templater = getPlugin<TemplaterPlugin>(this.app, "templater-obsidian")?.templater;
		if (!templater?.create_new_note_from_template) throw new NoteError("Templater is not installed or not enabled");
		if (!type.templatePath) throw new NoteError(`Note type "${type.name}" has no template set`);

		const template = this.app.vault.getAbstractFileByPath(normalizePath(type.templatePath));
		if (!(template instanceof TFile)) throw new NoteError(`Template not found: ${type.templatePath}`);

		const folderPath = this.folderFor(event, type, folderOverride);
		const folder = await ensureFolder(this.app, folderPath === "/" ? "" : folderPath);

		const file = await templater.create_new_note_from_template(
			template,
			folder,
			this.filenameFor(event, type),
			type.openAfterCreate
		);

		// Templater can only see the event through `lastEvent` (see the README), so
		// stamping the id here is what makes the note findable next time.
		if (file instanceof TFile) {
			await this.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
				frontmatter[EVENT_ID_KEY] = event.id;
			});
		}
	}
}
