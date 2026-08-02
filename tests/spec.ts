import { moment } from "obsidian";
import { formatDuration, parseDuration, resolveDate } from "../src/dates";
import {
	compileTitlePattern,
	compileTitlePatterns,
	isValidPeriod,
	parseQuery,
	resolveAccounts,
	resolveCalendars,
	QueryError,
} from "../src/query";
import { DEFAULT_SETTINGS, migrateSettings } from "../src/settings";
import {
	placeholderMap,
	quickAddChoices,
	sanitiseFolder,
	sanitiseSegment,
	substitute,
	templateCandidates,
} from "../src/notes";
import type { CalEvent } from "../src/types";

let passed = 0;
const failures: string[] = [];

function check(name: string, actual: unknown, expected: unknown): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) passed++;
	else failures.push(`${name}\n    expected ${e}\n    actual   ${a}`);
}

function throws(name: string, fn: () => unknown): void {
	try {
		fn();
		failures.push(`${name}\n    expected a QueryError, but it returned normally`);
	} catch (error) {
		if (error instanceof QueryError) passed++;
		else failures.push(`${name}\n    expected QueryError, got ${(error as Error).message}`);
	}
}

const today = moment().startOf("day");
const fmt = (m: ReturnType<typeof moment> | null) => (m ? m.format("YYYY-MM-DD HH:mm:ss") : null);

// ---- dates ----
check("today@start", fmt(resolveDate("today", "start")), today.format("YYYY-MM-DD 00:00:00"));
check("today@end", fmt(resolveDate("today", "end")), today.format("YYYY-MM-DD 23:59:59"));
check("tomorrow@start", fmt(resolveDate("tomorrow", "start")), today.clone().add(1, "day").format("YYYY-MM-DD 00:00:00"));
check("bare offset +3d", fmt(resolveDate("+3d", "start")), today.clone().add(3, "days").format("YYYY-MM-DD 00:00:00"));
check("today+2w@end", fmt(resolveDate("today+2w", "end")), today.clone().add(2, "weeks").format("YYYY-MM-DD 23:59:59"));
check("sow-1w", fmt(resolveDate("sow-1w", "start")), today.clone().startOf("week").subtract(1, "week").format("YYYY-MM-DD 00:00:00"));
check("eom is precise", fmt(resolveDate("eom", "start")), today.clone().endOf("month").format("YYYY-MM-DD 23:59:59"));
check("iso date@end", fmt(resolveDate("2026-08-14", "end")), "2026-08-14 23:59:59");
check("iso datetime keeps time", fmt(resolveDate("2026-08-14T09:30", "end")), "2026-08-14 09:30:00");
check("hour offset stays precise", fmt(resolveDate("now+2h", "end"))?.slice(0, 10), moment().add(2, "hours").format("YYYY-MM-DD"));
check("month vs minute: 1m", parseDuration("1m"), { value: 1, unit: "months" });
check("minutes need min", parseDuration("90min"), { value: 90, unit: "minutes" });
check("2 weeks", parseDuration("2 weeks"), { value: 2, unit: "weeks" });
check("garbage duration", parseDuration("soon"), null);
check("garbage date", resolveDate("next tuesday-ish", "start"), null);

const start = moment("2026-08-14T09:30");
check("duration 1h30", formatDuration(start, start.clone().add(90, "minutes"), false), "1h 30m");
check("duration 45m", formatDuration(start, start.clone().add(45, "minutes"), false), "45m");
check("duration all-day", formatDuration(start.clone().startOf("day"), start.clone().endOf("day"), true), "all day");

// ---- query ----
const base = { ...DEFAULT_SETTINGS };

const plain = parseQuery("", base);
check("default view", plain.query.view, "agenda");
check("default group", plain.query.group, "date");
check("default fields", plain.query.fields, ["time", "title", "location", "link"]);
check("default range end = +7d", fmt(plain.query.to), today.clone().add(7, "days").format("YYYY-MM-DD 23:59:59"));
check("no warnings", plain.warnings, []);

const table = parseQuery("view: table\ncolumns: date, time, title, calendar", base);
check("table view", table.query.view, "table");
check("table columns", table.query.columns, ["date", "time", "title", "calendar"]);
check("table group defaults to none", table.query.group, "none");

const list = parseQuery("view: list\nperiod: 1m\nlimit: 5", base);
check("list view", list.query.view, "list");
check("period 1m", fmt(list.query.to), today.clone().add(1, "month").format("YYYY-MM-DD 23:59:59"));
check("limit", list.query.limit, 5);

const fields = parseQuery("show:\n  - attendees\n  - meet\nhide: location", base);
check("show adds, alias meet -> link, hide removes", fields.query.fields, ["time", "title", "link", "attendees"]);

const filters = parseQuery(
	["calendars: Work, Personal", "exclude: Birthdays", "all-day: only", "declined: show", "title-match: /standup/i", "search: review"].join("\n"),
	base
);
check("calendars list", filters.query.calendars, ["Work", "Personal"]);
check("exclude list", filters.query.excludeCalendars, ["Birthdays"]);
check("all-day only", filters.query.allDay, "only");
check("declined: show", filters.query.hideDeclined, false);
check("title match works", filters.query.titleMatch?.test("Daily Standup"), true);
check("search passthrough", filters.query.search, "review");

const refresh = parseQuery("refresh: 5m", base);
check("refresh 5m -> 300s", refresh.query.refresh, 300);
check("refresh clamp", parseQuery("refresh: 10", base).query.refresh, 30);
check("clamp warning", parseQuery("refresh: 10", base).warnings, ["`refresh` is clamped to a 30 second minimum"]);

check("unknown key warns", parseQuery("perod: 7d", base).warnings, ["Unknown option `perod`"]);
check("unknown field warns", parseQuery("show: sparkles", base).warnings, ["`show` — unknown field \"sparkles\""]);

throws("bad view", () => parseQuery("view: kanban", base));
throws("bad date", () => parseQuery("from: whenever", base));
throws("inverted range", () => parseQuery("from: today\nto: yesterday", base));
throws("bad limit", () => parseQuery("limit: 0", base));
throws("bad boolean", () => parseQuery("declined: maybe", base));
throws("bad regex", () => parseQuery("title-match: /[unclosed/", base));
throws("list block", () => parseQuery("- one\n- two", base));

// ---- calendar and account resolution ----
const PERSONAL = "alex@example.com";
const WORK = "user@work.example";

function cal(accountId: string, accountLabel: string, id: string, name: string) {
	return { key: `${accountId}::${id}`, id, name, accountId, accountLabel };
}

const available = [
	cal(PERSONAL, "Personal", PERSONAL, "Alex Rivera"),
	cal(PERSONAL, "Personal", "shared123@group.calendar.google.com", "Household"),
	cal(PERSONAL, "Personal", "en.uk#holiday@group.v.calendar.google.com", "Holidays in United Kingdom"),
	cal(WORK, "Work", WORK, "Alex Rivera"),
	cal(WORK, "Work", "team456@group.calendar.google.com", "Clinic rota"),
];

check("match by substring", resolveCalendars(["rota"], available).matched, [`${WORK}::team456@group.calendar.google.com`]);
check("match by id", resolveCalendars(["shared123@group.calendar.google.com"], available).matched, [
	`${PERSONAL}::shared123@group.calendar.google.com`,
]);
check("match by full key", resolveCalendars([`${WORK}::${WORK}`], available).matched, [`${WORK}::${WORK}`]);
check("unmatched reported", resolveCalendars(["nope"], available).unmatched, ["nope"]);
check("dedupes overlaps", resolveCalendars(["rota", "Clinic rota"], available).matched.length, 1);

// A bare name present in both accounts should hit both, and say so.
const bothAccounts = resolveCalendars(["Alex Rivera"], available);
check("bare name spans accounts", bothAccounts.matched.length, 2);
check("ambiguity is flagged", bothAccounts.ambiguous, ["Alex Rivera"]);

// `account/calendar` narrows it to one.
const scoped = resolveCalendars(["work/Alex Rivera"], available);
check("account/calendar narrows", scoped.matched, [`${WORK}::${WORK}`]);
check("scoped is unambiguous", scoped.ambiguous, []);
check("scope by address", resolveCalendars([`${PERSONAL}/Alex Rivera`], available).matched, [`${PERSONAL}::${PERSONAL}`]);

// A slash that is not an account prefix must not silently drop the calendar.
const slashy = [...available, cal(WORK, "Work", "odd@group.calendar.google.com", "On-call / Rota")];
check("non-prefix slash still matches", resolveCalendars(["On-call / Rota"], slashy).matched, [
	`${WORK}::odd@group.calendar.google.com`,
]);

check("account by label", resolveAccounts(["work"], available).matched, [WORK]);
check("account by address", resolveAccounts([PERSONAL], available).matched, [PERSONAL]);
check("account unmatched", resolveAccounts(["nope"], available).unmatched, ["nope"]);
check("accounts option parsed", parseQuery("accounts: work, personal", base).query.accounts, ["work", "personal"]);
check("exclude-accounts parsed", parseQuery("exclude-accounts: work", base).query.excludeAccounts, ["work"]);
check("group: account allowed", parseQuery("group: account", base).query.group, "account");
check("account field allowed", parseQuery("show: account", base).warnings, []);

// ---- migration from the single-account 0.1.0 shape ----
const legacyTokens = { accessToken: "at", refreshToken: "rt", expiresAt: 123 };
const legacy = migrateSettings({
	clientId: "cid",
	clientSecret: "secret",
	tokens: legacyTokens,
	knownCalendars: [
		{ id: PERSONAL, name: "Alex Rivera", color: "#fff", primary: true },
		{ id: "shared123@group.calendar.google.com", name: "Household", color: "#abc", primary: false },
	],
	defaultCalendars: ["shared123@group.calendar.google.com"],
	defaultPeriod: "14d",
});

check("legacy tokens become one account", legacy.accounts.length, 1);
check("legacy account keeps its tokens", legacy.accounts[0].tokens, legacyTokens);
check("legacy calendars are re-keyed", legacy.knownCalendars.map((c) => c.key), [
	"legacy-account::alex@example.com",
	"legacy-account::shared123@group.calendar.google.com",
]);
check("legacy calendars gain an account", legacy.knownCalendars[0].accountId, "legacy-account");
check("legacy selection is re-keyed", legacy.defaultCalendars, ["legacy-account::shared123@group.calendar.google.com"]);
check("shared client is preserved", legacy.clientId, "cid");
check("unrelated settings survive", legacy.defaultPeriod, "14d");
check("legacy tokens field is dropped", "tokens" in legacy, false);

// Re-running migration must be a no-op, not a second account.
check("migration is idempotent", migrateSettings(JSON.parse(JSON.stringify(legacy))).accounts.length, 1);

const current = migrateSettings({
	accounts: [{ id: WORK, label: "Work", tokens: legacyTokens }],
	tokens: legacyTokens,
	knownCalendars: [cal(WORK, "Work", "team456@group.calendar.google.com", "Clinic rota")],
});
check("existing accounts are not duplicated", current.accounts.map((a) => a.id), [WORK]);
check("stray legacy tokens ignored when accounts exist", current.knownCalendars.length, 1);

check("empty data yields defaults", migrateSettings(undefined).accounts, []);
check("null data yields defaults", migrateSettings(null).defaultView, "agenda");
check("untagged cached calendars are dropped", migrateSettings({ accounts: [], knownCalendars: [{ id: "x", name: "x" }] }).knownCalendars, []);

// A fresh migration must not hand back the module-level default arrays.
const a = migrateSettings({});
const b = migrateSettings({});
a.knownCalendars.push(cal(WORK, "Work", "z", "Z") as never);
check("default arrays are not shared", b.knownCalendars.length, 0);
check("DEFAULT_SETTINGS untouched", DEFAULT_SETTINGS.knownCalendars.length, 0);

// ---- meeting-note templating ----
const sampleEvent: CalEvent = {
	id: "evt_abc123",
	calendarKey: `${WORK}::team456@group.calendar.google.com`,
	calendarId: "team456@group.calendar.google.com",
	calendarName: "Clinic rota",
	calendarColor: "#3f51b5",
	accountId: WORK,
	accountLabel: "Work",
	title: "Practice review / Q3",
	start: moment("2026-08-14T09:30:00"),
	end: moment("2026-08-14T11:00:00"),
	allDay: false,
	location: "Room 2",
	description: "Quarterly numbers",
	link: "https://calendar.google.com/event?eid=abc",
	meetUrl: "https://meet.google.com/xyz-abcd-efg",
	status: "confirmed",
	organizer: "Sam Patel",
	attendees: [
		{ email: "sam@example.com", name: "Sam Patel", response: "accepted", self: false, optional: false, resource: false },
		{ email: "room2@example.com", name: "Room 2", response: "accepted", self: false, optional: false, resource: true },
		{ email: WORK, name: "Alex", response: "accepted", self: true, optional: false, resource: false },
	],
	selfResponse: "accepted",
	recurring: false,
};

check("substitutes title", substitute("# {{title}}", sampleEvent, true), "# Practice review / Q3");
check("default date format", substitute("{{date}}", sampleEvent, true), "2026-08-14");
check("custom date format", substitute("{{date:YYYY/MM}}", sampleEvent, true), "2026/08");
check("format containing a colon", substitute("{{start:HH:mm}}", sampleEvent, true), "09:30");
check("time range respects 24h", substitute("{{time}}", sampleEvent, true), "09:30–11:00");
check("time range respects 12h", substitute("{{time}}", sampleEvent, false), "9:30am–11:00am");
check("duration", substitute("{{duration}}", sampleEvent, true), "1h 30m");
check("resources excluded from attendees", substitute("{{attendees}}", sampleEvent, true), "Sam Patel, Alex");
check("attendees-list is bulleted", substitute("{{attendees-list}}", sampleEvent, true), "- Sam Patel\n- Alex");
check("meet url", substitute("{{meet}}", sampleEvent, true), "https://meet.google.com/xyz-abcd-efg");
check("iso start", substitute("{{start-iso}}", sampleEvent, true), sampleEvent.start.toISOString());
check("organiser spelling accepted", substitute("{{organiser}}", sampleEvent, true), "Sam Patel");
check("whitespace tolerated", substitute("{{ title }}", sampleEvent, true), "Practice review / Q3");

// Unknown placeholders belong to other plugins and must survive untouched.
check("unknown placeholder untouched", substitute("{{tp.date.now}} {{VALUE:x}}", sampleEvent, true), "{{tp.date.now}} {{VALUE:x}}");
check("templater syntax untouched", substitute("<% tp.file.title %>", sampleEvent, true), "<% tp.file.title %>");

check("placeholder map is flat strings", placeholderMap(sampleEvent, true).title, "Practice review / Q3");
check("placeholder map covers id", placeholderMap(sampleEvent, true).id, "evt_abc123");

// A title with a slash must not become a nested path.
check("filename strips path separators", sanitiseSegment(substitute("{{date}} {{title}}", sampleEvent, true)), "2026-08-14 Practice review - Q3");
check("filename strips wikilink breakers", sanitiseSegment('a#b^c[d]e|f:g*h?i"j<k>l'), "a-b-c-d-e-f-g-h-i-j-k-l");
check("leading dots stripped", sanitiseSegment("...hidden"), "hidden");
check("empty segment stays empty", sanitiseSegment("   "), "");
check("folder keeps separators", sanitiseFolder("Meetings/2026/Q3"), "Meetings/2026/Q3");
check("folder cleans segments", sanitiseFolder("Meetings//2026:Q3/"), "Meetings/2026-Q3");
check("empty folder becomes root", sanitiseFolder("  /  "), "/");

check("note-type parsed", parseQuery("note-type: 1:1", base).query.noteType, "1:1");
check("note-folder parsed", parseQuery("note-folder: Meetings/{{date:YYYY}}", base).query.noteFolder, "Meetings/{{date:YYYY}}");
check("meeting-note adds the field", parseQuery("meeting-note: true", base).query.fields.includes("note"), true);
check("note field off by default", parseQuery("", base).query.fields.includes("note"), false);
check("note-type implies the link", parseQuery("note-type: 1:1", base).query.fields.includes("note"), true);
check("meeting-note: false wins", parseQuery("note-type: 1:1\nmeeting-note: false", base).query.fields.includes("note"), false);
check(
	"setting turns the link on",
	parseQuery("", { ...base, showMeetingNoteLink: true }).query.fields.includes("note"),
	true
);

// ---- discovery of QuickAdd choices and template files ----
type FakeApp = Parameters<typeof quickAddChoices>[0];

function fakeApp(options: {
	choices?: unknown[];
	quickAddTemplateFolder?: string;
	templaterFolder?: string;
	coreFolder?: string;
	files?: string[];
	noQuickAdd?: boolean;
}): FakeApp {
	const plugins: Record<string, unknown> = {};
	if (!options.noQuickAdd) {
		plugins.quickadd = {
			api: { executeChoice: () => Promise.resolve() },
			settings: { choices: options.choices ?? [], templateFolderPath: options.quickAddTemplateFolder },
		};
	}
	if (options.templaterFolder !== undefined) {
		plugins["templater-obsidian"] = { settings: { templates_folder: options.templaterFolder }, templater: {} };
	}
	return {
		plugins: { plugins },
		internalPlugins: { plugins: { templates: { instance: { options: { folder: options.coreFolder } } } } },
		vault: { getMarkdownFiles: () => (options.files ?? []).map((path) => ({ path })) },
	} as unknown as FakeApp;
}

check("no QuickAdd yields no choices", quickAddChoices(fakeApp({ noQuickAdd: true })), []);
check("no choices configured", quickAddChoices(fakeApp({ choices: [] })), []);

const flat = quickAddChoices(
	fakeApp({
		choices: [
			{ id: "1", name: "Capture idea", type: "Capture" },
			{ id: "2", name: "Meeting note", type: "Template" },
		],
	})
);
check("flat choices found", flat.map((c) => c.name), ["Capture idea", "Meeting note"]);
check("type is surfaced", flat[1].type, "Template");

// Multi choices are folders: walk into them, but never offer them as runnable.
const nested = quickAddChoices(
	fakeApp({
		choices: [
			{
				id: "m",
				name: "Meetings",
				type: "Multi",
				choices: [
					{ id: "a", name: "1:1", type: "Template" },
					{ id: "b", name: "Client call", type: "Template" },
				],
			},
			{ id: "z", name: "Daily", type: "Template" },
		],
	})
);
check("Multi itself is not offered", nested.some((c) => c.name === "Meetings"), false);
check("nested choices are found", nested.map((c) => c.name).sort(), ["1:1", "Client call", "Daily"]);
check("nested label shows its parent", nested.find((c) => c.name === "1:1")?.label, "Meetings / 1:1");
check("executeChoice still gets the bare name", nested.find((c) => c.name === "1:1")?.name, "1:1");

// QuickAdd resolves by name alone, so same-named choices are ambiguous there too.
const dupes = quickAddChoices(
	fakeApp({
		choices: [
			{ id: "a", name: "Note", type: "Template" },
			{ id: "m", name: "Work", type: "Multi", choices: [{ id: "b", name: "Note", type: "Capture" }] },
		],
	})
);
check("duplicates are flagged", dupes.every((c) => c.label.includes("duplicate")), true);
check("duplicates are both listed", dupes.length, 2);

const files = ["_Assets/Templates/Meeting.md", "_Assets/Templates/Daily.md", "Notes/Random.md", "90 Templates/Call.md"];
// localeCompare groups each folder's files together; the exact folder order is
// whatever collation says, which is fine for a picker.
check(
	"candidates come from configured folders only",
	templateCandidates(fakeApp({ files, templaterFolder: "_Assets/Templates", quickAddTemplateFolder: "90 Templates" })),
	["_Assets/Templates/Daily.md", "_Assets/Templates/Meeting.md", "90 Templates/Call.md"]
);
check(
	"notes outside the template folders are excluded",
	templateCandidates(fakeApp({ files, templaterFolder: "_Assets/Templates" })).includes("Notes/Random.md"),
	false
);
check("no folders configured yields no candidates", templateCandidates(fakeApp({ files })), []);
check(
	"core templates folder is honoured",
	templateCandidates(fakeApp({ files, coreFolder: "Notes" })),
	["Notes/Random.md"]
);
check(
	"a folder prefix does not match a sibling",
	templateCandidates(fakeApp({ files: ["Templates2/x.md", "Templates/y.md"], templaterFolder: "Templates" })),
	["Templates/y.md"]
);

// ---- settings validation ----
check("period accepts a duration", isValidPeriod("7d"), true);
check("period accepts a date keyword", isValidPeriod("eom"), true);
check("period accepts an offset", isValidPeriod("+2w"), true);
check("period rejects a typo", isValidPeriod("7dd"), false);
check("period rejects prose", isValidPeriod("a fortnight"), false);
check("period rejects empty", isValidPeriod("  "), false);

// 0 must hide the description, not show all of it.
const zeroLen = { ...base, descriptionLength: 0 };
check(
	"descriptionLength 0 hides",
	parseQuery("show: description", zeroLen).query.descriptionLength,
	0
);

// ---- the two date formats are independent ----
const bothFormats = parseQuery("view: list\ngroup: date\nheading-format: dddd\ndate-format: DD/MM", base);
check("heading-format drives headings", bothFormats.query.dateHeadingFormat, "dddd");
check("date-format drives cells", bothFormats.query.tableDateFormat, "DD/MM");
check("neither leaks into the other", bothFormats.warnings, []);

check("heading-format alone leaves cells at the default", parseQuery("heading-format: dddd", base).query.tableDateFormat, base.tableDateFormat);
check(
	"date-format alone leaves headings at the default",
	parseQuery("view: table\ndate-format: DD/MM", base).query.dateHeadingFormat,
	base.dateHeadingFormat
);

// Setting one where it cannot apply is a no-op, so say so rather than stay silent.
check(
	"date-format in a default agenda warns",
	parseQuery("date-format: dddd", base).warnings,
	["`date-format` has no effect here — no date is displayed. Did you mean `heading-format`?"]
);
check(
	"heading-format warns when not grouped by date",
	parseQuery("group: calendar\nheading-format: dddd", base).warnings,
	["`heading-format` has no effect here — events are not grouped by date."]
);
check("date-format is fine in a table", parseQuery("view: table\ndate-format: DD/MM", base).warnings, []);
check("date-format is fine in a list", parseQuery("view: list\ndate-format: DD/MM", base).warnings, []);
check(
	"date-format is fine in an agenda showing the date",
	parseQuery("group: calendar\nshow: date\ndate-format: DD/MM", base).warnings,
	[]
);
check(
	"table with date dropped from columns warns",
	parseQuery("view: table\ncolumns: time, title\ndate-format: DD/MM", base).warnings,
	["`date-format` has no effect here — no date is displayed. Did you mean `heading-format`?"]
);

// ---- hiding events by title pattern ----
const hides = (pattern: string, title: string) => compileTitlePattern(pattern)?.test(title) ?? null;

// A bare word is an exact match, not a substring.
check("bare pattern matches exactly", hides("EOD", "EOD"), true);
check("bare pattern is case-insensitive", hides("eod", "EOD"), true);
check("bare pattern does not match a substring", hides("EOD", "Prep for EOD"), false);
check("bare pattern does not match a prefix", hides("EOD", "EOD review"), false);
check("multi-word exact", hides("Start of Day", "Start of Day"), true);

// Globs.
check("trailing star is a prefix", hides("Start of *", "Start of Day"), true);
check("trailing star needs the prefix", hides("Start of *", "End of Day"), false);
check("surrounding stars match anywhere", hides("*EOD*", "Prep for EOD tomorrow"), true);
check("surrounding stars still match exact", hides("*EOD*", "EOD"), true);
check("leading star is a suffix", hides("*Day", "Start of Day"), true);
check("question mark matches one char", hides("Day ?", "Day 1"), true);
check("question mark is not a run", hides("Day ?", "Day 12"), false);

// Regex form.
check("regex form", hides("/^(EOD|SOD)$/", "SOD"), true);
check("regex is case-insensitive by default", hides("/eod/", "My EOD note"), true);
check("regex honours explicit flags", hides("/^eod$/", "EOD"), true);
check("invalid regex compiles to null", compileTitlePattern("/[unclosed/"), null);
check("blank pattern is ignored", compileTitlePattern("   "), null);

// A `g` flag would make .test() stateful across events.
const global = compileTitlePattern("/EOD/g");
check("g flag stripped", global?.flags.includes("g"), false);
check("so repeated tests agree", [global?.test("EOD"), global?.test("EOD")], [true, true]);

// Regex metacharacters in a glob are literal.
check("dots are literal in globs", hides("a.b", "axb"), false);
check("dots match themselves", hides("a.b", "a.b"), true);
check("parens are literal", hides("Standup (daily)", "Standup (daily)"), true);
check("plus is literal", hides("C++", "C++"), true);

const invalid: string[] = [];
check(
	"compiles a list and reports only real failures",
	compileTitlePatterns(["EOD", "  ", "/[bad/", "Start of *"], (p) => invalid.push(p)).length,
	2
);
check("invalid reported", invalid, ["/[bad/"]);

// Settings list and block list combine.
const hidden = { ...base, hiddenTitles: ["EOD"] };
check("settings patterns compile", parseQuery("", hidden).query.hiddenTitles.length, 1);
check("block adds to settings", parseQuery("hide-titles: Start of *, Lunch", hidden).query.hiddenTitles.length, 3);
check("block alone", parseQuery("hide-titles: EOD", base).query.hiddenTitles.length, 1);
check("yaml list form", parseQuery("hide-titles:\n  - EOD\n  - Lunch", base).query.hiddenTitles.length, 2);
check("bad pattern warns", parseQuery("hide-titles: /[bad/", base).warnings, ['Invalid hide pattern "/[bad/"']);
check("hide-titles is a known option", parseQuery("hide-titles: EOD", base).warnings, []);

console.log(`\n${passed} passed, ${failures.length} failed`);
for (const failure of failures) console.log(`\n  ✗ ${failure}`);
process.exit(failures.length === 0 ? 0 : 1);
