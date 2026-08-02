import type { OAuthTokens } from "./auth";
import type { CalendarInfo, ViewMode } from "./types";

export interface AccountSettings {
	/** The account's primary calendar address, which doubles as a stable unique id. */
	id: string;
	label: string;
	/** Per-account OAuth client, for workspaces that will not allow an outside one. */
	clientId?: string;
	clientSecret?: string;
	tokens: OAuthTokens | null;
}

/**
 * How a meeting note gets made. `builtin` creates the file directly (and can run
 * Templater over it afterwards); the other two hand off to that plugin entirely.
 */
export type NoteMode = "builtin" | "quickadd" | "templater";

export interface NoteType {
	id: string;
	name: string;
	mode: NoteMode;
	/** Used by `builtin` and `templater`. */
	templatePath?: string;
	/** Used by `quickadd`. */
	quickAddChoice?: string;
	/** Overrides the global note folder. */
	folder?: string;
	/** Overrides the global filename format. */
	filenameFormat?: string;
	openAfterCreate: boolean;
}

export interface GCalSettings {
	/** OAuth client used by every account that does not override it. */
	clientId: string;
	clientSecret: string;
	/** 0 = ask the OS for a free port each time. */
	oauthPort: number;
	accounts: AccountSettings[];

	/** Cached from the API so the settings tab can render instantly. */
	knownCalendars: CalendarInfo[];
	/** Calendar keys (`accountId::calendarId`) queried when a block names none. Empty = all. */
	defaultCalendars: string[];

	defaultView: ViewMode;
	defaultPeriod: string;
	use24HourTime: boolean;
	dateHeadingFormat: string;
	tableDateFormat: string;
	hideDeclined: boolean;

	/** Seconds an API response stays reusable. */
	cacheTtl: number;
	/** Seconds between automatic block refreshes. 0 disables. */
	autoRefresh: number;
	descriptionLength: number;

	// --- Meeting notes ---
	noteTypes: NoteType[];
	/** Id or name of the type used when a block does not name one. */
	defaultNoteType: string;
	noteFolder: string;
	noteFilenameFormat: string;
	/** Run Templater's commands over notes created by the `builtin` mode. */
	runTemplaterOnCreate: boolean;
	/** Whether blocks show the note link without asking for it. */
	showMeetingNoteLink: boolean;
}

export const DEFAULT_SETTINGS: GCalSettings = {
	clientId: "",
	clientSecret: "",
	oauthPort: 0,
	accounts: [],

	knownCalendars: [],
	defaultCalendars: [],

	defaultView: "agenda",
	defaultPeriod: "7d",
	use24HourTime: true,
	dateHeadingFormat: "dddd D MMMM",
	tableDateFormat: "ddd D MMM",
	hideDeclined: true,

	cacheTtl: 300,
	autoRefresh: 0,
	descriptionLength: 200,

	noteTypes: [],
	defaultNoteType: "",
	noteFolder: "Meetings",
	noteFilenameFormat: "{{date:YYYY-MM-DD}} {{title}}",
	runTemplaterOnCreate: true,
	showMeetingNoteLink: false,
};

/** Shape written by 0.1.0, which held a single account inline. */
interface LegacySettings {
	tokens?: OAuthTokens | null;
	knownCalendars?: Array<CalendarInfo & { accountId?: string }>;
	defaultCalendars?: string[];
}

export const CALENDAR_KEY_SEPARATOR = "::";

export function calendarKey(accountId: string, calendarId: string): string {
	return `${accountId}${CALENDAR_KEY_SEPARATOR}${calendarId}`;
}

/**
 * Folds a pre-multi-account `data.json` into the current shape: the lone token set
 * becomes one account, and its cached calendars are re-keyed against it.
 */
export function migrateSettings(raw: unknown): GCalSettings {
	const stored = (raw ?? {}) as Partial<GCalSettings> & LegacySettings;
	const settings: GCalSettings = Object.assign({}, DEFAULT_SETTINGS, stored);

	// Copy the arrays so a default-valued field never aliases DEFAULT_SETTINGS.
	settings.accounts = Array.isArray(stored.accounts) ? [...stored.accounts] : [];
	settings.knownCalendars = Array.isArray(settings.knownCalendars) ? [...settings.knownCalendars] : [];
	settings.defaultCalendars = Array.isArray(settings.defaultCalendars) ? [...settings.defaultCalendars] : [];
	settings.noteTypes = Array.isArray(settings.noteTypes) ? [...settings.noteTypes] : [];

	const legacyTokens = stored.tokens;
	if (legacyTokens && settings.accounts.length === 0) {
		// The address is unknown until the calendar list is fetched, so use a
		// placeholder id; reconnecting replaces it with the real address.
		const id = "legacy-account";
		settings.accounts = [{ id, label: "Google Calendar", tokens: legacyTokens }];
		settings.knownCalendars = (stored.knownCalendars ?? []).map((calendar) => ({
			...calendar,
			accountId: id,
			accountLabel: "Google Calendar",
			key: calendarKey(id, calendar.id),
		}));
		settings.defaultCalendars = (stored.defaultCalendars ?? []).map((calendarId) =>
			calendarId.includes(CALENDAR_KEY_SEPARATOR) ? calendarId : calendarKey(id, calendarId)
		);
	}

	// Drop the legacy field so it cannot be re-migrated on a later load.
	delete (settings as LegacySettings).tokens;

	// Guard against calendars cached by a build that predates account tagging.
	settings.knownCalendars = settings.knownCalendars.filter((calendar) => calendar.accountId && calendar.key);

	return settings;
}
