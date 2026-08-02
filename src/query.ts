import { parseYaml } from "obsidian";
import type { Moment } from "./moment-shim";
import { addDuration, parseDuration, resolveDate } from "./dates";
import type { GCalSettings } from "./settings";
import type { AllDayMode, Field, GroupMode, ViewMode } from "./types";

export interface GCalQuery {
	from: Moment;
	to: Moment;
	view: ViewMode;
	group: GroupMode;
	/** Names or IDs as written by the user; resolved against the calendar list later. */
	calendars: string[];
	excludeCalendars: string[];
	/** Account labels or addresses; empty means every connected account. */
	accounts: string[];
	excludeAccounts: string[];
	fields: Field[];
	columns: Field[];
	limit: number | null;
	search?: string;
	titleMatch?: RegExp;
	titleExclude?: RegExp;
	/** Compiled from the settings list plus the block's own `hide-titles`. */
	hiddenTitles: RegExp[];
	allDay: AllDayMode;
	hideDeclined: boolean;
	hideCancelled: boolean;
	use24HourTime: boolean;
	dateHeadingFormat: string;
	tableDateFormat: string;
	descriptionLength: number;
	emptyMessage: string;
	/** Seconds; 0 disables. */
	refresh: number;
	showRefreshButton: boolean;
	/** Name of the meeting-note type this block creates; undefined uses the default. */
	noteType?: string;
	/** Folder override for notes created from this block. */
	noteFolder?: string;
}

export interface ParsedQuery {
	query: GCalQuery;
	warnings: string[];
}

export class QueryError extends Error {}

const VIEWS: ViewMode[] = ["agenda", "list", "table"];
const GROUPS: GroupMode[] = ["date", "calendar", "account", "none"];
const ALL_DAY_MODES: AllDayMode[] = ["include", "exclude", "only"];

const FIELDS: Field[] = [
	"date",
	"day",
	"time",
	"start",
	"end",
	"duration",
	"title",
	"calendar",
	"account",
	"location",
	"description",
	"attendees",
	"organizer",
	"status",
	"response",
	"link",
	"note",
];

const FIELD_ALIASES: Record<string, Field> = {
	meet: "link",
	url: "link",
	guests: "attendees",
	people: "attendees",
	where: "location",
	notes: "description",
	desc: "description",
	length: "duration",
	cal: "calendar",
	rsvp: "response",
	who: "account",
	"meeting-note": "note",
	meetingnote: "note",
};

const DEFAULT_FIELDS: Record<ViewMode, Field[]> = {
	agenda: ["time", "title", "location", "link"],
	list: ["date", "time", "title"],
	table: ["date", "time", "title"],
};

/** Every key the block understands, used to flag typos rather than silently ignore them. */
const KNOWN_KEYS = new Set([
	"from",
	"to",
	"period",
	"view",
	"group",
	"calendar",
	"calendars",
	"account",
	"accounts",
	"exclude",
	"exclude-calendars",
	"excludecalendars",
	"exclude-accounts",
	"excludeaccounts",
	"fields",
	"show",
	"hide",
	"columns",
	"limit",
	"search",
	"query",
	"title-match",
	"titlematch",
	"match",
	"title-exclude",
	"titleexclude",
	"hide-titles",
	"hidetitles",
	"exclude-titles",
	"excludetitles",
	"all-day",
	"allday",
	"declined",
	"cancelled",
	"canceled",
	"time-format",
	"timeformat",
	"date-format",
	"dateformat",
	"heading-format",
	"headingformat",
	"description-length",
	"descriptionlength",
	"empty",
	"empty-message",
	"emptymessage",
	"refresh",
	"refresh-button",
	"refreshbutton",
	"meeting-note",
	"meetingnote",
	"note-type",
	"notetype",
	"note-folder",
	"notefolder",
]);

function normaliseKey(key: string): string {
	return key.trim().toLowerCase().replace(/[_\s]+/g, "-");
}

/** Accepts a YAML list, a comma-separated string, or a single scalar. */
function toList(value: unknown): string[] {
	if (value === null || value === undefined) return [];
	if (Array.isArray(value)) return value.flatMap((item) => toList(item));
	return String(value)
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
}

function toBool(value: unknown, key: string): boolean {
	if (typeof value === "boolean") return value;
	const text = String(value).trim().toLowerCase();
	if (["true", "yes", "on", "show", "1"].includes(text)) return true;
	if (["false", "no", "off", "hide", "0"].includes(text)) return false;
	throw new QueryError(`\`${key}\` expects true or false, got "${value}"`);
}

function toEnum<T extends string>(value: unknown, allowed: T[], key: string): T {
	const text = String(value).trim().toLowerCase();
	const match = allowed.find((option) => option === text);
	if (!match) throw new QueryError(`\`${key}\` expects one of ${allowed.join(", ")} — got "${value}"`);
	return match;
}

function toFields(value: unknown, key: string, warnings: string[]): Field[] {
	const fields: Field[] = [];
	for (const raw of toList(value)) {
		const text = raw.toLowerCase();
		const field = FIELDS.includes(text as Field) ? (text as Field) : FIELD_ALIASES[text];
		if (!field) {
			warnings.push(`\`${key}\` — unknown field "${raw}"`);
			continue;
		}
		if (!fields.includes(field)) fields.push(field);
	}
	return fields;
}

function toRegex(value: unknown, key: string): RegExp {
	const text = String(value).trim();
	const delimited = /^\/(.*)\/([gimsuy]*)$/.exec(text);
	try {
		return delimited ? new RegExp(delimited[1], delimited[2]) : new RegExp(text, "i");
	} catch (error) {
		throw new QueryError(`\`${key}\` is not a valid regular expression: ${(error as Error).message}`);
	}
}

/**
 * Interval in seconds. Accepts a bare number (`60`) or `30s` / `5m` / `1h`.
 * Note `m` is minutes here, unlike in `period` where it means months — an
 * interval measured in months would never be meaningful.
 */
function toSeconds(value: unknown, key: string): number {
	const text = String(value).trim().toLowerCase();
	if (/^\d+(\.\d+)?$/.test(text)) return Number(text);

	const match = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)$/.exec(text);
	if (!match) throw new QueryError(`\`${key}\` expects an interval such as 90, 30s, 5m or 1h — got "${value}"`);

	const unit = match[2];
	const multiplier = unit.startsWith("h") ? 3600 : unit.startsWith("m") ? 60 : 1;
	return Number(match[1]) * multiplier;
}

/**
 * Whether a string is usable as `period` — either a duration (`7d`) or a date
 * expression to run until (`eom`). Exported so the settings tab can reject a typo
 * at the point it is made, rather than breaking every block that relies on it.
 */
export function isValidPeriod(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed) return false;
	return Boolean(parseDuration(trimmed) ?? resolveDate(trimmed, "end"));
}

/**
 * Compiles one hide pattern.
 *
 * `/foo/i` is a regular expression. Anything else is a glob: `*` matches any run
 * of characters and `?` matches one, anchored at both ends and case-insensitive.
 * So `EOD` hides only an event called exactly that, `Start of *` hides anything
 * beginning that way, and `*EOD*` hides anything containing it.
 */
export function compileTitlePattern(pattern: string): RegExp | null {
	const text = pattern.trim();
	if (!text) return null;

	const delimited = /^\/(.*)\/([gimsuy]*)$/.exec(text);
	if (delimited) {
		try {
			// `g` is dropped: a global regex carries lastIndex between .test() calls.
			return new RegExp(delimited[1], delimited[2].replace(/g/g, "") || "i");
		} catch {
			return null;
		}
	}

	const escaped = text
		.replace(/[.+^${}()|[\]\\]/g, "\\$&")
		.replace(/\*/g, ".*")
		.replace(/\?/g, ".");
	return new RegExp(`^${escaped}$`, "i");
}

export function compileTitlePatterns(patterns: string[], onInvalid?: (pattern: string) => void): RegExp[] {
	const compiled: RegExp[] = [];
	for (const pattern of patterns) {
		const regex = compileTitlePattern(pattern);
		if (regex) compiled.push(regex);
		else if (pattern.trim()) onInvalid?.(pattern);
	}
	return compiled;
}

function requireDate(value: unknown, key: string, edge: "start" | "end"): Moment {
	const resolved = resolveDate(String(value), edge);
	if (!resolved) {
		throw new QueryError(
			`\`${key}\` could not be understood: "${value}". Try today, tomorrow, sow, eom, +3d, or 2026-08-14.`
		);
	}
	return resolved;
}

export function parseQuery(source: string, settings: GCalSettings): ParsedQuery {
	const warnings: string[] = [];

	let raw: unknown;
	try {
		raw = source.trim() ? parseYaml(source) : {};
	} catch (error) {
		throw new QueryError(`Could not read the block options: ${(error as Error).message}`);
	}
	if (raw === null || raw === undefined) raw = {};
	if (typeof raw !== "object" || Array.isArray(raw)) {
		throw new QueryError("Block options must be written as `key: value` lines");
	}

	const options = new Map<string, unknown>();
	for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
		const normalised = normaliseKey(key);
		if (!KNOWN_KEYS.has(normalised)) warnings.push(`Unknown option \`${key}\``);
		options.set(normalised, value);
	}
	const get = (...keys: string[]) => keys.map((key) => options.get(key)).find((value) => value !== undefined);
	const has = (...keys: string[]) => keys.some((key) => options.has(key));

	const view = has("view") ? toEnum(get("view"), VIEWS, "view") : settings.defaultView;

	const from = requireDate(get("from") ?? "today", "from", "start");
	let to: Moment;
	if (has("to")) {
		to = requireDate(get("to"), "to", "end");
	} else {
		const periodText = String(get("period") ?? settings.defaultPeriod);
		const duration = parseDuration(periodText);
		if (!duration) {
			// `period: eom` is a reasonable thing to write, so fall back to date resolution.
			const resolved = resolveDate(periodText, "end");
			if (!resolved) throw new QueryError(`\`period\` expects a duration such as 7d, 2w or 1m — got "${periodText}"`);
			to = resolved;
		} else {
			to = addDuration(from, duration).endOf("day");
		}
	}
	if (to.isSameOrBefore(from)) {
		throw new QueryError(`The range ends before it starts (${from.format()} → ${to.format()})`);
	}

	let fields = has("fields") ? toFields(get("fields"), "fields", warnings) : [...DEFAULT_FIELDS[view]];

	// `meeting-note` is a friendlier spelling of adding or removing the `note` field.
	// Naming a note-type or folder implies you want the link too.
	const wantsNote = has("meeting-note", "meetingnote")
		? toBool(get("meeting-note", "meetingnote"), "meeting-note")
		: has("note-type", "notetype", "note-folder", "notefolder") || settings.showMeetingNoteLink;
	if (wantsNote && !has("fields")) fields.push("note");

	if (has("show")) {
		for (const field of toFields(get("show"), "show", warnings)) {
			if (!fields.includes(field)) fields.push(field);
		}
	}
	if (has("hide")) {
		const hidden = toFields(get("hide"), "hide", warnings);
		fields = fields.filter((field) => !hidden.includes(field));
	}

	const columns = has("columns") ? toFields(get("columns"), "columns", warnings) : fields;
	if (view === "table" && columns.length === 0) {
		throw new QueryError("A table needs at least one column");
	}

	const limitRaw = get("limit");
	let limit: number | null = null;
	if (limitRaw !== undefined) {
		const parsed = Number(limitRaw);
		if (!Number.isFinite(parsed) || parsed < 1) throw new QueryError(`\`limit\` expects a positive number — got "${limitRaw}"`);
		limit = Math.floor(parsed);
	}

	const timeFormat = get("time-format", "timeformat");
	const use24HourTime =
		timeFormat === undefined ? settings.use24HourTime : String(timeFormat).trim().toLowerCase().startsWith("24");

	const refreshRaw = get("refresh");
	const refresh = refreshRaw === undefined ? settings.autoRefresh : Math.max(0, toSeconds(refreshRaw, "refresh"));
	if (refresh > 0 && refresh < 30) warnings.push("`refresh` is clamped to a 30 second minimum");

	const calendars = toList(get("calendars", "calendar"));
	const titleMatchRaw = get("title-match", "titlematch", "match");
	const titleExcludeRaw = get("title-exclude", "titleexclude");
	const searchRaw = get("search", "query");
	const emptyRaw = get("empty", "empty-message", "emptymessage");
	const dateFormatRaw = get("date-format", "dateformat");
	const headingFormatRaw = get("heading-format", "headingformat");
	const descriptionLengthRaw = get("description-length", "descriptionlength");
	// The block's list adds to the one in settings rather than replacing it.
	const hiddenTitles = compileTitlePatterns(
		[...settings.hiddenTitles, ...toList(get("hide-titles", "hidetitles", "exclude-titles", "excludetitles"))],
		(pattern) => warnings.push(`Invalid hide pattern "${pattern}"`)
	);

	const noteTypeRaw = get("note-type", "notetype");
	const noteFolderRaw = get("note-folder", "notefolder");

	const group: GroupMode = has("group")
		? toEnum(get("group"), GROUPS, "group")
		: view === "agenda"
			? "date"
			: "none";

	// The two date formats address different things, so a block that sets the wrong
	// one would otherwise just do nothing.
	const showsDateCell =
		view === "agenda"
			? fields.includes("date") && group !== "date"
			: (view === "table" ? columns : fields).includes("date");

	if (dateFormatRaw !== undefined && !showsDateCell) {
		warnings.push("`date-format` has no effect here — no date is displayed. Did you mean `heading-format`?");
	}
	if (headingFormatRaw !== undefined && group !== "date") {
		warnings.push("`heading-format` has no effect here — events are not grouped by date.");
	}

	return {
		warnings,
		query: {
			from,
			to,
			view,
			group,
			calendars: calendars.length ? calendars : settings.defaultCalendars,
			excludeCalendars: toList(get("exclude", "exclude-calendars", "excludecalendars")),
			accounts: toList(get("accounts", "account")),
			excludeAccounts: toList(get("exclude-accounts", "excludeaccounts")),
			fields,
			columns,
			limit,
			search: searchRaw === undefined ? undefined : String(searchRaw),
			titleMatch: titleMatchRaw === undefined ? undefined : toRegex(titleMatchRaw, "title-match"),
			titleExclude: titleExcludeRaw === undefined ? undefined : toRegex(titleExcludeRaw, "title-exclude"),
			hiddenTitles,
			allDay: has("all-day", "allday") ? toEnum(get("all-day", "allday"), ALL_DAY_MODES, "all-day") : "include",
			hideDeclined: has("declined") ? !toBool(get("declined"), "declined") : settings.hideDeclined,
			hideCancelled: has("cancelled", "canceled") ? !toBool(get("cancelled", "canceled"), "cancelled") : true,
			use24HourTime,
			dateHeadingFormat: headingFormatRaw === undefined ? settings.dateHeadingFormat : String(headingFormatRaw),
			tableDateFormat: dateFormatRaw === undefined ? settings.tableDateFormat : String(dateFormatRaw),
			descriptionLength:
				descriptionLengthRaw === undefined ? settings.descriptionLength : Math.max(0, Number(descriptionLengthRaw) || 0),
			emptyMessage: emptyRaw === undefined ? "No events in this period." : String(emptyRaw),
			refresh: refresh > 0 ? Math.max(30, refresh) : 0,
			showRefreshButton: has("refresh-button", "refreshbutton")
				? toBool(get("refresh-button", "refreshbutton"), "refresh-button")
				: true,
			noteType: noteTypeRaw === undefined ? undefined : String(noteTypeRaw).trim() || undefined,
			noteFolder: noteFolderRaw === undefined ? undefined : String(noteFolderRaw).trim() || undefined,
		},
	};
}

/** The subset of CalendarInfo the resolvers need, kept narrow so tests can supply plain objects. */
export interface ResolvableCalendar {
	key: string;
	id: string;
	name: string;
	accountId: string;
	accountLabel: string;
}

function matchesAccount(calendar: ResolvableCalendar, needle: string): boolean {
	const id = calendar.accountId.toLowerCase();
	const label = calendar.accountLabel.toLowerCase();
	return id === needle || label === needle || label.includes(needle) || id.startsWith(`${needle}@`);
}

/**
 * Maps user-written account labels or addresses onto account IDs.
 * `work` matches an account labelled "Work", and `alex@example.com` matches by address.
 */
export function resolveAccounts(
	requested: string[],
	available: ResolvableCalendar[]
): { matched: string[]; unmatched: string[] } {
	const matched = new Set<string>();
	const unmatched: string[] = [];

	for (const term of requested) {
		const needle = term.trim().toLowerCase();
		const hits = available.filter((calendar) => matchesAccount(calendar, needle));
		if (hits.length === 0) unmatched.push(term);
		else for (const hit of hits) matched.add(hit.accountId);
	}

	return { matched: [...matched], unmatched };
}

/**
 * Maps user-written calendar names or IDs onto calendar keys.
 *
 * A bare term is matched across every account, so `calendars: personal` picks up a
 * "Personal" calendar in each. `account/calendar` narrows to one account first, which
 * is how you disambiguate when the same name exists in two. Matching within a scope
 * is by exact ID, then exact name, then substring — all case-insensitive.
 */
export function resolveCalendars(
	requested: string[],
	available: ResolvableCalendar[]
): { matched: string[]; unmatched: string[]; ambiguous: string[] } {
	const matched = new Set<string>();
	const unmatched: string[] = [];
	const ambiguous: string[] = [];

	for (const term of requested) {
		const trimmed = term.trim();

		// A calendar key from settings is already fully qualified.
		if (available.some((calendar) => calendar.key === trimmed)) {
			matched.add(trimmed);
			continue;
		}

		let scope = available;
		let calendarPart = trimmed;
		const slash = trimmed.indexOf("/");
		if (slash > 0) {
			const accountNeedle = trimmed.slice(0, slash).trim().toLowerCase();
			const scoped = available.filter((calendar) => matchesAccount(calendar, accountNeedle));
			if (scoped.length > 0) {
				scope = scoped;
				calendarPart = trimmed.slice(slash + 1).trim();
			}
			// If the prefix matches no account, fall through and treat the whole
			// string as a calendar name — some calendars legitimately contain "/".
		}

		const needle = calendarPart.toLowerCase();
		const byId = scope.filter((calendar) => calendar.id.toLowerCase() === needle);
		const byName = byId.length ? byId : scope.filter((calendar) => calendar.name.toLowerCase() === needle);
		const hits = byName.length ? byName : scope.filter((calendar) => calendar.name.toLowerCase().includes(needle));

		if (hits.length === 0) {
			unmatched.push(term);
			continue;
		}
		for (const hit of hits) matched.add(hit.key);
		if (new Set(hits.map((hit) => hit.accountId)).size > 1) ambiguous.push(term);
	}

	return { matched: [...matched], unmatched, ambiguous };
}
