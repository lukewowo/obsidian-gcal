import {
	MarkdownRenderChild,
	Modal,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	moment,
	type MarkdownPostProcessorContext,
	type Setting,
	type SettingDefinition,
	type SettingDefinitionGroup,
	type SettingDefinitionItem,
	type SettingDefinitionList,
	type SettingDefinitionPage,
	type TFile,
} from "obsidian";
import type { Moment } from "moment";
import {
	AuthError,
	GoogleAuth,
	authorize,
	revoke,
	type AuthConfig,
	type ConsentUi,
	type OAuthTokens,
} from "./auth";
import { GCalClient, describeError } from "./gcal";
import {
	QueryError,
	isValidPeriod,
	parseQuery,
	resolveAccounts,
	resolveCalendars,
	type GCalQuery,
} from "./query";
import { renderEvents, renderMessage, type NoteActions } from "./render";
import {
	MeetingNotes,
	quickAddAvailable,
	quickAddChoices,
	templateCandidates,
	templaterAvailable,
} from "./notes";
import {
	ACCOUNT_KEY_PREFIX,
	CALENDAR_KEY_PREFIX,
	DEFAULT_SETTINGS,
	NOTE_TYPE_KEY_PREFIX,
	migrateSettings,
	type AccountSettings,
	type GCalSettings,
	type NoteType,
} from "./settings";
import type { CalEvent, CalendarInfo } from "./types";

// Deliberately specific: `gcal` alone is short enough to collide with other plugins.
const BLOCK_LANGUAGE = "gcal-events";

interface CacheEntry {
	events: CalEvent[];
	fetchedAt: number;
}

/** The live auth + client pair for one connected account. */
interface AccountRuntime {
	auth: GoogleAuth;
	client: GCalClient;
}

export interface QueryResult {
	events: CalEvent[];
	warnings: string[];
}

/**
 * Shown while the browser round-trip is in flight. The loopback listener accepts
 * the redirect from any browser on this machine, so offering the URL is what makes
 * "sign in as a different account, in a different browser" possible.
 */
class ConsentModal extends Modal {
	private settled = false;

	constructor(
		app: import("obsidian").App,
		private readonly url: string,
		private readonly cancel: () => void
	) {
		super(app);
	}

	onOpen(): void {
		this.titleEl.setText("Waiting for Google");

		this.contentEl.createEl("p", {
			text: "Your browser should have opened Google's consent screen. Approve access there and this will close by itself.",
		});
		this.contentEl.createEl("p", {
			cls: "mod-warning",
			text: "To use a different Google account — or a browser where that account is already signed in — copy this link and paste it there instead. It works from any browser on this computer.",
		});

		const box = this.contentEl.createDiv({ cls: "gcal-consent-url" });
		box.createEl("code", { text: this.url });

		const buttons = this.contentEl.createDiv({ cls: "modal-button-container" });

		const copy = buttons.createEl("button", { cls: "mod-cta", text: "Copy link" });
		copy.addEventListener("click", () => {
			void navigator.clipboard.writeText(this.url).then(() => {
				copy.setText("Copied");
				new Notice("Link copied — paste it into any browser on this computer");
			});
		});

		const reopen = buttons.createEl("button", { text: "Open again" });
		reopen.addEventListener("click", () => {
			window.open(this.url, "_blank");
		});

		const abort = buttons.createEl("button", { cls: "mod-warning", text: "Cancel" });
		abort.addEventListener("click", () => {
			this.close();
		});
	}

	/** Called by the auth flow when it settles, so closing does not double-cancel. */
	settle(): void {
		this.settled = true;
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.settled) this.cancel();
	}
}

export default class GoogleCalendarAgendaPlugin extends Plugin {
	settings!: GCalSettings;
	notes!: MeetingNotes;

	private runtimes = new Map<string, AccountRuntime>();
	private cache = new Map<string, CacheEntry>();
	private readonly blocks = new Set<GCalBlock>();
	private calendarsPromise: Promise<{ calendars: CalendarInfo[]; errors: string[] }> | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.rebuildRuntimes();

		this.notes = new MeetingNotes(this.app, () => this.settings);
		// The event-id index is only valid until the vault changes under it.
		this.registerEvent(this.app.metadataCache.on("changed", () => this.notes.invalidateIndex()));
		this.registerEvent(this.app.vault.on("rename", () => this.notes.invalidateIndex()));
		this.registerEvent(this.app.vault.on("delete", () => this.notes.invalidateIndex()));

		this.registerMarkdownCodeBlockProcessor(BLOCK_LANGUAGE, (source, el, ctx) => {
			ctx.addChild(new GCalBlock(el, source, this, ctx));
		});

		this.addSettingTab(new GCalSettingTab(this));

		this.addCommand({
			id: "refresh",
			name: "Refresh calendar data",
			callback: () => {
				this.invalidateCache();
				this.refreshAllBlocks();
				new Notice("Google Calendar refreshed");
			},
		});

		this.addCommand({
			id: "add-account",
			name: "Add a Google account",
			callback: () => void this.addAccount(),
		});

		this.addCommand({
			id: "insert-block",
			name: "Insert calendar block",
			editorCallback: (editor) => {
				editor.replaceSelection(
					[
						`\`\`\`${BLOCK_LANGUAGE}`,
						"from: today",
						`period: ${this.settings.defaultPeriod}`,
						`view: ${this.settings.defaultView}`,
						"```",
						"",
					].join("\n")
				);
			},
		});
	}

	onunload(): void {
		this.cache.clear();
		this.blocks.clear();
		this.runtimes.clear();
	}

	async loadSettings(): Promise<void> {
		this.settings = migrateSettings(await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	// --- Accounts ---------------------------------------------------------

	/** Client credentials for an account, falling back to the shared ones. */
	private configFor(account: AccountSettings): AuthConfig {
		return {
			clientId: (account.clientId || this.settings.clientId).trim(),
			clientSecret: (account.clientSecret || this.settings.clientSecret).trim(),
			port: this.settings.oauthPort,
		};
	}

	/** Rebuilds the auth/client pair for every account, dropping any that were removed. */
	private rebuildRuntimes(): void {
		this.runtimes.clear();
		for (const account of this.settings.accounts) {
			const id = account.id;
			const find = (): AccountSettings | undefined => this.settings.accounts.find((a) => a.id === id);

			const auth = new GoogleAuth(
				() => {
					const current = find();
					return current ? this.configFor(current) : { clientId: "", clientSecret: "", port: 0 };
				},
				() => find()?.tokens ?? null,
				async (tokens: OAuthTokens | null) => {
					const current = find();
					if (!current) return;
					current.tokens = tokens;
					await this.saveSettings();
				}
			);

			const client = new GCalClient(auth, () => {
				const current = find();
				return { id, label: current?.label ?? id };
			});

			this.runtimes.set(id, { auth, client });
		}
	}

	connectedAccounts(): AccountSettings[] {
		return this.settings.accounts.filter((account) => Boolean(account.tokens?.refreshToken));
	}

	hasAnyAccount(): boolean {
		return this.connectedAccounts().length > 0;
	}

	/**
	 * Runs consent, then identifies the account by its primary calendar address so
	 * re-adding the same Google account updates it in place rather than duplicating it.
	 */
	async addAccount(existing?: AccountSettings): Promise<void> {
		if (!Platform.isDesktopApp) {
			new Notice("Adding an account needs the desktop app. Once connected there, this vault's calendars work on mobile too.", 10000);
			return;
		}

		const config = existing
			? this.configFor(existing)
			: {
					clientId: this.settings.clientId.trim(),
					clientSecret: this.settings.clientSecret.trim(),
					port: this.settings.oauthPort,
				};

		let modal: ConsentModal | null = null;
		const ui: ConsentUi = {
			onPrompt: (url, cancel) => {
				modal = new ConsentModal(this.app, url, cancel);
				modal.open();
			},
			onSettled: () => modal?.settle(),
		};

		try {
			const tokens = await authorize(config, ui);
			const address = await this.probeAddress(config, tokens);
			const id = address ?? existing?.id ?? crypto.randomUUID();

			const already = this.settings.accounts.find((account) => account.id === id);
			if (already) {
				already.tokens = tokens;
				if (existing && existing.id !== id) {
					// Reconnecting an account that turned out to be a different address:
					// drop the stale record rather than leaving an orphan.
					this.settings.accounts = this.settings.accounts.filter((account) => account.id !== existing.id);
					this.purgeAccountData(existing.id);
				}
			} else if (existing) {
				this.purgeAccountData(existing.id);
				existing.id = id;
				existing.tokens = tokens;
				if (!existing.label || existing.label === "Google Calendar") existing.label = address ?? id;
			} else {
				this.settings.accounts.push({ id, label: address ?? id, tokens });
			}

			await this.saveSettings();
			this.rebuildRuntimes();
			this.invalidateCache();
			await this.getCalendars();
			this.refreshAllBlocks();
			new Notice(`Connected ${address ?? "Google account"}`);
		} catch (error) {
			new Notice(`Google Calendar: ${describeError(error)}`, 10000);
			throw error;
		}
	}

	/** Identifies a freshly authorised account before it exists in settings. */
	private async probeAddress(config: AuthConfig, tokens: OAuthTokens): Promise<string | null> {
		let held: OAuthTokens | null = tokens;
		const auth = new GoogleAuth(
			() => config,
			() => held,
			async (next) => {
				held = next;
			}
		);
		try {
			return await new GCalClient(auth, () => ({ id: "probe", label: "probe" })).fetchPrimaryAddress();
		} catch {
			// Falling back to a generated id is better than failing the whole connect.
			return null;
		}
	}

	async removeAccount(id: string): Promise<void> {
		const account = this.settings.accounts.find((entry) => entry.id === id);
		if (!account) return;

		if (account.tokens?.refreshToken) await revoke(account.tokens.refreshToken);
		this.settings.accounts = this.settings.accounts.filter((entry) => entry.id !== id);
		this.purgeAccountData(id);

		await this.saveSettings();
		this.rebuildRuntimes();
		this.invalidateCache();
		this.refreshAllBlocks();
	}

	/** Drops cached calendars and default selections belonging to an account. */
	private purgeAccountData(id: string): void {
		this.settings.knownCalendars = this.settings.knownCalendars.filter((calendar) => calendar.accountId !== id);
		const remaining = new Set(this.settings.knownCalendars.map((calendar) => calendar.key));
		this.settings.defaultCalendars = this.settings.defaultCalendars.filter((key) => remaining.has(key));
	}

	async renameAccount(id: string, label: string): Promise<void> {
		const account = this.settings.accounts.find((entry) => entry.id === id);
		if (!account) return;
		account.label = label;
		for (const calendar of this.settings.knownCalendars) {
			if (calendar.accountId === id) calendar.accountLabel = label;
		}
		await this.saveSettings();
		this.refreshAllBlocks();
	}

	// --- Data -------------------------------------------------------------

	registerBlock(block: GCalBlock): void {
		this.blocks.add(block);
	}

	unregisterBlock(block: GCalBlock): void {
		this.blocks.delete(block);
	}

	refreshAllBlocks(): void {
		for (const block of this.blocks) void block.render();
	}

	invalidateCache(): void {
		this.cache.clear();
		this.calendarsPromise = null;
	}

	/**
	 * Calendar lists for every connected account. One account failing does not
	 * take down the others — its error is returned for the block to surface.
	 */
	async getCalendars(): Promise<{ calendars: CalendarInfo[]; errors: string[] }> {
		if (!this.calendarsPromise) {
			this.calendarsPromise = this.fetchAllCalendars().catch((error) => {
				this.calendarsPromise = null;
				throw error;
			});
		}
		return this.calendarsPromise;
	}

	private async fetchAllCalendars(): Promise<{ calendars: CalendarInfo[]; errors: string[] }> {
		const accounts = this.connectedAccounts();
		const settled = await Promise.allSettled(
			accounts.map((account) => {
				const runtime = this.runtimes.get(account.id);
				if (!runtime) return Promise.reject(new Error(`No runtime for ${account.label}`));
				return runtime.client.listCalendars();
			})
		);

		const calendars: CalendarInfo[] = [];
		const errors: string[] = [];
		settled.forEach((outcome, index) => {
			const label = accounts[index].label;
			if (outcome.status === "fulfilled") calendars.push(...outcome.value);
			else errors.push(`${label}: ${describeError(outcome.reason)}`);
		});

		// Keep whatever succeeded so a single dead account cannot wipe the cache.
		if (calendars.length > 0 || errors.length === 0) {
			const failedAccounts = new Set(
				accounts.filter((_, index) => settled[index].status === "rejected").map((account) => account.id)
			);
			const retained = this.settings.knownCalendars.filter((calendar) => failedAccounts.has(calendar.accountId));
			this.settings.knownCalendars = [...calendars, ...retained];
			await this.saveSettings();
		}

		return { calendars: this.settings.knownCalendars, errors };
	}

	async reloadCalendars(): Promise<{ calendars: CalendarInfo[]; errors: string[] }> {
		this.calendarsPromise = null;
		return this.getCalendars();
	}

	private async fetchCalendar(calendar: CalendarInfo, from: Moment, to: Moment, search?: string): Promise<CalEvent[]> {
		const key = [
			calendar.key,
			from.clone().startOf("minute").toISOString(),
			to.clone().startOf("minute").toISOString(),
			search ?? "",
		].join("|");

		const cached = this.cache.get(key);
		if (cached && Date.now() - cached.fetchedAt < this.settings.cacheTtl * 1000) {
			return cached.events;
		}

		const runtime = this.runtimes.get(calendar.accountId);
		if (!runtime) throw new Error(`Account "${calendar.accountLabel}" is no longer connected`);

		const events = await runtime.client.listEvents(
			{ calendarId: calendar.id, timeMin: from, timeMax: to, search },
			calendar
		);
		this.cache.set(key, { events, fetchedAt: Date.now() });
		return events;
	}

	async runQuery(query: GCalQuery): Promise<QueryResult> {
		const { calendars: available, errors } = await this.getCalendars();
		const warnings = [...errors];

		let selected = available;

		if (query.accounts.length > 0) {
			const { matched, unmatched } = resolveAccounts(query.accounts, available);
			if (unmatched.length) warnings.push(`No account matched: ${unmatched.join(", ")}`);
			selected = selected.filter((calendar) => matched.includes(calendar.accountId));
		}
		if (query.excludeAccounts.length > 0) {
			const { matched } = resolveAccounts(query.excludeAccounts, available);
			selected = selected.filter((calendar) => !matched.includes(calendar.accountId));
		}

		if (query.calendars.length > 0) {
			const { matched, unmatched, ambiguous } = resolveCalendars(query.calendars, selected);
			if (unmatched.length) warnings.push(`No calendar matched: ${unmatched.join(", ")}`);
			for (const term of ambiguous) {
				warnings.push(`"${term}" matched calendars in more than one account — use \`account/calendar\` to narrow it.`);
			}
			selected = selected.filter((calendar) => matched.includes(calendar.key));
		}
		if (query.excludeCalendars.length > 0) {
			const { matched } = resolveCalendars(query.excludeCalendars, selected);
			selected = selected.filter((calendar) => !matched.includes(calendar.key));
		}

		if (selected.length === 0) {
			warnings.push("No calendars selected — check the `calendars` option or the plugin settings.");
			return { events: [], warnings };
		}

		const settled = await Promise.allSettled(
			selected.map((calendar) => this.fetchCalendar(calendar, query.from, query.to, query.search))
		);

		const events: CalEvent[] = [];
		settled.forEach((outcome, index) => {
			if (outcome.status === "fulfilled") events.push(...outcome.value);
			else warnings.push(`${selected[index].name}: ${describeError(outcome.reason)}`);
		});

		// Every calendar failing is an error, not a quietly empty agenda.
		if (events.length === 0 && settled.every((outcome) => outcome.status === "rejected") && settled.length > 0) {
			throw settled[0].reason;
		}

		const filtered = events.filter((event) => keepEvent(event, query)).sort(compareEvents);
		return {
			events: query.limit === null ? filtered : filtered.slice(0, query.limit),
			warnings,
		};
	}
}

function keepEvent(event: CalEvent, query: GCalQuery): boolean {
	if (query.hideCancelled && event.status === "cancelled") return false;
	if (query.hideDeclined && event.selfResponse === "declined") return false;
	if (query.allDay === "exclude" && event.allDay) return false;
	if (query.allDay === "only" && !event.allDay) return false;
	if (query.titleMatch && !query.titleMatch.test(event.title)) return false;
	if (query.titleExclude && query.titleExclude.test(event.title)) return false;
	if (query.hiddenTitles.some((pattern) => pattern.test(event.title))) return false;
	return true;
}

/** All-day events sort above timed ones on the same day, then by start, then title. */
function compareEvents(a: CalEvent, b: CalEvent): number {
	const dayDiff = a.start.clone().startOf("day").valueOf() - b.start.clone().startOf("day").valueOf();
	if (dayDiff !== 0) return dayDiff;
	if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
	return a.start.valueOf() - b.start.valueOf() || a.title.localeCompare(b.title);
}

class GCalBlock extends MarkdownRenderChild {
	private refreshTimer: number | null = null;
	private renderToken = 0;

	constructor(
		containerEl: HTMLElement,
		private readonly source: string,
		private readonly plugin: GoogleCalendarAgendaPlugin,
		_ctx: MarkdownPostProcessorContext
	) {
		super(containerEl);
	}

	onload(): void {
		this.plugin.registerBlock(this);
		void this.render();
	}

	onunload(): void {
		this.plugin.unregisterBlock(this);
		this.clearTimer();
	}

	private clearTimer(): void {
		if (this.refreshTimer !== null) {
			window.clearInterval(this.refreshTimer);
			this.refreshTimer = null;
		}
	}

	async render(): Promise<void> {
		// Guard against an auto-refresh landing after a manual one.
		const token = ++this.renderToken;

		let parsed;
		try {
			parsed = parseQuery(this.source, this.plugin.settings);
		} catch (error) {
			this.clearTimer();
			renderMessage(
				this.containerEl,
				"error",
				error instanceof QueryError ? `Invalid ${BLOCK_LANGUAGE} block` : "Could not read this block",
				describeError(error)
			);
			return;
		}

		const { query, warnings } = parsed;

		// Surfaced here rather than in parseQuery, which cannot see the configured types.
		if (query.noteType && !this.plugin.notes.hasType(query.noteType)) {
			const known = this.plugin.notes.types().map((type) => type.name).join(", ") || "none configured";
			warnings.push(`Unknown note type "${query.noteType}". Available: ${known}`);
		}

		if (!this.plugin.hasAnyAccount()) {
			this.clearTimer();
			renderMessage(
				this.containerEl,
				"notice",
				"No Google account connected",
				Platform.isDesktopApp
					? "Add your OAuth client details in the plugin settings, then add an account."
					: "Connect an account in the desktop app. Once its settings sync to this device, events appear here.",
				Platform.isDesktopApp
					? { label: "Add account", onClick: () => void this.plugin.addAccount().catch(() => undefined) }
					: undefined
			);
			return;
		}

		this.scheduleRefresh(query.refresh);

		if (this.containerEl.childElementCount === 0) {
			renderMessage(this.containerEl, "notice", "Loading events…");
		}

		try {
			const result = await this.plugin.runQuery(query);
			if (token !== this.renderToken) return;

			renderEvents(this.containerEl, result.events, query, {
				warnings: [...warnings, ...result.warnings],
				lastUpdated: moment(),
				onRefresh: () => {
					this.plugin.invalidateCache();
					void this.render();
				},
				notes: this.noteActions(query),
			});
		} catch (error) {
			if (token !== this.renderToken) return;
			const needsAuth = error instanceof AuthError;
			renderMessage(
				this.containerEl,
				"error",
				needsAuth ? "Google Calendar needs reconnecting" : "Could not load events",
				describeError(error),
				{
					label: "Retry",
					onClick: () => {
						this.plugin.invalidateCache();
						void this.render();
					},
				}
			);
		}
	}

	/**
	 * Bridges the renderer to the vault. `note-folder` on the block is applied by
	 * wrapping each call, so the block's override beats the note type's own folder.
	 */
	private noteActions(query: GCalQuery): NoteActions {
		const notes = this.plugin.notes;
		return {
			typeNames: () => notes.types().map((type) => type.name),
			existingPath: (event, typeName) =>
				notes.target(event, typeName, query.noteFolder)?.existing?.path ?? null,
			openOrCreate: (event, typeName) => {
				void notes.createOrOpen(event, typeName, query.noteFolder).then(() => {
					// The label flips from Create to Open once the note exists.
					void this.render();
				});
			},
		};
	}

	private scheduleRefresh(seconds: number): void {
		this.clearTimer();
		if (seconds <= 0) return;
		this.refreshTimer = window.setInterval(() => {
			this.plugin.invalidateCache();
			void this.render();
		}, seconds * 1000);
		this.registerInterval(this.refreshTimer);
	}
}
/**
 * Settings are declared rather than rendered, which is what puts them in
 * Obsidian's settings search. The base class owns the DOM; this class only
 * describes the shape and bridges control keys to `GCalSettings`.
 *
 * Keys are either a plain field name on the settings object, or a prefixed
 * composite for the repeated rows: `calendar:<calendarKey>`,
 * `account:<accountId>:<field>`, `noteType:<typeId>:<field>`.
 */
class GCalSettingTab extends PluginSettingTab {
	constructor(private readonly plugin: GoogleCalendarAgendaPlugin) {
		super(plugin.app, plugin);
	}

	// --- Key routing ------------------------------------------------------

	/** Splits `prefix:<id>:<field>`. Ids may contain colons; field names may not. */
	private static split(key: string, prefix: string): { id: string; field: string } | null {
		if (!key.startsWith(prefix)) return null;
		const rest = key.slice(prefix.length);
		const cut = rest.lastIndexOf(":");
		return cut < 0 ? { id: rest, field: "" } : { id: rest.slice(0, cut), field: rest.slice(cut + 1) };
	}

	private account(id: string): AccountSettings | undefined {
		return this.plugin.settings.accounts.find((entry) => entry.id === id);
	}

	private noteType(id: string): NoteType | undefined {
		return this.plugin.settings.noteTypes.find((entry) => entry.id === id);
	}

	getControlValue(key: string): unknown {
		const settings = this.plugin.settings;

		if (key === "hiddenTitles") return settings.hiddenTitles.join("\n");

		if (key.startsWith(CALENDAR_KEY_PREFIX)) {
			return settings.defaultCalendars.includes(key.slice(CALENDAR_KEY_PREFIX.length));
		}

		const account = GCalSettingTab.split(key, ACCOUNT_KEY_PREFIX);
		if (account) {
			const entry = this.account(account.id);
			if (!entry) return "";
			if (account.field === "label") return entry.label;
			if (account.field === "clientId") return entry.clientId ?? "";
			return entry.clientSecret ?? "";
		}

		const type = GCalSettingTab.split(key, NOTE_TYPE_KEY_PREFIX);
		if (type) {
			const entry = this.noteType(type.id);
			if (!entry) return "";
			switch (type.field) {
				case "name":
					return entry.name;
				case "mode":
					return entry.mode;
				case "templatePath":
					return entry.templatePath ?? "";
				case "quickAddChoice":
					return entry.quickAddChoice ?? "";
				case "folder":
					return entry.folder ?? "";
				case "filenameFormat":
					return entry.filenameFormat ?? "";
				case "openAfterCreate":
					return entry.openAfterCreate;
				default:
					return "";
			}
		}

		return (settings as unknown as Record<string, unknown>)[key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.plugin.settings;
		let rerenderBlocks = true;

		if (key === "hiddenTitles") {
			settings.hiddenTitles = String(value)
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
		} else if (key.startsWith(CALENDAR_KEY_PREFIX)) {
			const calendarKey = key.slice(CALENDAR_KEY_PREFIX.length);
			const selected = new Set(settings.defaultCalendars);
			if (value) selected.add(calendarKey);
			else selected.delete(calendarKey);
			settings.defaultCalendars = [...selected];
		} else {
			const account = GCalSettingTab.split(key, ACCOUNT_KEY_PREFIX);
			const type = GCalSettingTab.split(key, NOTE_TYPE_KEY_PREFIX);

			if (account) {
				const entry = this.account(account.id);
				if (!entry) return;
				const text = String(value).trim();
				if (account.field === "label") {
					await this.plugin.renameAccount(entry.id, text || entry.id);
					return;
				}
				if (account.field === "clientId") entry.clientId = text || undefined;
				else entry.clientSecret = text || undefined;
				rerenderBlocks = false;
			} else if (type) {
				const entry = this.noteType(type.id);
				if (!entry) return;
				const text = typeof value === "string" ? value.trim() : "";
				switch (type.field) {
					case "name":
						entry.name = text || entry.id;
						break;
					case "mode":
						entry.mode = text as NoteType["mode"];
						break;
					case "templatePath":
						entry.templatePath = text || undefined;
						break;
					case "quickAddChoice":
						entry.quickAddChoice = text || undefined;
						break;
					case "folder":
						entry.folder = text || undefined;
						break;
					case "filenameFormat":
						entry.filenameFormat = text || undefined;
						break;
					case "openAfterCreate":
						entry.openAfterCreate = Boolean(value);
						break;
				}
			} else {
				(settings as unknown as Record<string, unknown>)[key] = value;
			}
		}

		await this.plugin.saveSettings();
		if (rerenderBlocks) this.plugin.refreshAllBlocks();
		// `visible` and `disabled` predicates are re-evaluated on update, which is
		// how the mode-specific note-type rows appear and disappear.
		this.update();
	}

	// --- Definitions ------------------------------------------------------

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			this.oauthClientGroup(),
			this.accountsList(),
			this.calendarsGroup(),
			this.defaultsGroup(),
			this.meetingNotesGroup(),
			this.noteTypesList(),
			this.syncingGroup(),
		];
	}

	private secretRow(name: string, desc: string, read: () => string, write: (value: string) => Promise<void>): SettingDefinition {
		// Rendered by hand because there is no masked control type.
		return {
			name,
			desc,
			render: (setting: Setting) => {
				setting.addText((text) => {
					text.inputEl.type = "password";
					text.inputEl.autocomplete = "off";
					text.setPlaceholder("GOCSPX-…").setValue(read());
					text.onChange((value) => {
						void write(value);
					});
				});
			},
		};
	}

	private oauthClientGroup(): SettingDefinitionGroup {
		const href = "https://console.cloud.google.com/apis/credentials";
		const intro = createFragment((frag) => {
			frag.appendText(
				"Create an OAuth client of type “Desktop app” in a Google Cloud project with the Calendar API enabled. One client can serve every account you add. "
			);
			const link = frag.createEl("a", { text: "Open Google Cloud credentials", href });
			link.addEventListener("click", (mouse) => {
				mouse.preventDefault();
				window.open(href, "_blank");
			});
		});

		return {
			type: "group",
			heading: "OAuth client",
			items: [
				{ name: "Setup", desc: intro, aliases: ["google", "cloud", "credentials"] },
				{
					name: "Client ID",
					desc: "Shared by every account unless one overrides it.",
					control: { type: "text", key: "clientId", placeholder: "xxxxx.apps.googleusercontent.com" },
				},
				this.secretRow(
					"Client secret",
					"Stored unencrypted in this plugin's data.json, like all Obsidian plugin settings.",
					() => this.plugin.settings.clientSecret,
					async (value) => {
						this.plugin.settings.clientSecret = value;
						await this.plugin.saveSettings();
					}
				),
				{
					type: "page",
					name: "Advanced",
					desc: "Callback port",
					items: [
						{
							name: "Callback port",
							desc: "0 lets the OS pick a free port each time, which is right for a Desktop app client. Set a fixed port only if you created a “Web application” client and registered http://127.0.0.1:PORT with it.",
							control: { type: "number", key: "oauthPort", min: 0, max: 65535, step: 1, defaultValue: 0 },
						},
					],
				},
			],
		};
	}

	private accountsList(): SettingDefinitionList {
		const accounts = this.plugin.settings.accounts;
		const desktop = Platform.isDesktopApp;

		return {
			type: "list",
			heading: "Accounts",
			emptyState: desktop
				? "No accounts yet. Fill in the OAuth client above, then add one."
				: "No accounts yet. Sign in on the desktop app; this device reads what it syncs.",
			addItem: desktop
				? {
						name: "Add account",
						action: () => {
							void this.plugin.addAccount().then(
								() => this.update(),
								() => this.update()
							);
						},
					}
				: undefined,
			onDelete: (index: number) => {
				const account = accounts[index];
				if (!account) return;
				void this.plugin.removeAccount(account.id).then(() => {
					new Notice(`Removed ${account.label}`);
					this.update();
				});
			},
			items: accounts.map((account): SettingDefinitionPage => {
				const calendars = this.plugin.settings.knownCalendars.filter((c) => c.accountId === account.id).length;
				const connected = Boolean(account.tokens?.refreshToken);
				return {
					type: "page",
					name: account.label,
					desc: connected ? `${account.id} · ${calendars} calendars` : `${account.id} · not connected`,
					status: connected ? null : "warning",
					items: [
						{
							name: "Label",
							desc: "What `accounts:` and `account/calendar` match against in a block.",
							control: { type: "text", key: `${ACCOUNT_KEY_PREFIX}${account.id}:label` },
						},
						{
							name: connected ? "Reconnect" : "Connect",
							desc: desktop
								? "Runs the Google consent flow again for this account."
								: "Signing in needs the desktop app.",
							disabled: !desktop,
							action: () => {
								void this.plugin.addAccount(account).then(
									() => this.update(),
									() => this.update()
								);
							},
						},
						{
							name: "Separate OAuth client",
							desc: "Only needed if a Workspace admin blocks outside apps. Leave empty to use the shared client above.",
						},
						{
							name: "Client ID",
							control: {
								type: "text",
								key: `${ACCOUNT_KEY_PREFIX}${account.id}:clientId`,
								placeholder: "Falls back to the shared client",
							},
						},
						this.secretRow(
							"Client secret",
							"",
							() => account.clientSecret ?? "",
							async (value) => {
								account.clientSecret = value.trim() || undefined;
								await this.plugin.saveSettings();
							}
						),
					],
				};
			}),
		};
	}

	private calendarsGroup(): SettingDefinitionGroup {
		const calendars = this.plugin.settings.knownCalendars;

		const items: SettingDefinition[] = calendars.length
			? calendars.map((calendar) => ({
					name: calendar.name,
					desc: `${calendar.accountLabel} · ${calendar.id}`,
					aliases: [calendar.accountLabel, calendar.id],
					control: { type: "toggle" as const, key: `${CALENDAR_KEY_PREFIX}${calendar.key}` },
				}))
			: [
					{
						name: "No calendars loaded",
						desc: this.plugin.hasAnyAccount()
							? "Use the reload button on this section."
							: "Add an account first.",
						searchable: false,
					},
				];

		return {
			type: "group",
			heading: "Calendars",
			search:
				calendars.length > 8
					? {
							placeholder: "Filter calendars",
							match: (def, query) =>
								`${def.name} ${typeof def.desc === "string" ? def.desc : ""}`
									.toLowerCase()
									.includes(query.toLowerCase()),
						}
					: undefined,
			extraButtons: [
				(button) =>
					button
						.setIcon("refresh-cw")
						.setTooltip("Reload the calendar list from Google")
						.setDisabled(!this.plugin.hasAnyAccount())
						.onClick(() => {
							void this.plugin.reloadCalendars().then(
								({ errors }) => {
									new Notice(errors.length ? `Updated with errors: ${errors.join("; ")}` : "Calendar list updated");
									this.update();
								},
								(error: unknown) => new Notice(`Google Calendar: ${describeError(error)}`, 10000)
							);
						}),
			],
			items,
		};
	}

	private defaultsGroup(): SettingDefinitionGroup {
		return {
			type: "group",
			heading: "Defaults",
			items: [
				{
					name: "View",
					desc: "Used when a block omits `view`.",
					control: {
						type: "dropdown",
						key: "defaultView",
						options: { agenda: "Agenda", list: "List", table: "Table" },
					},
				},
				{
					name: "Period",
					desc: "How far ahead to look when a block sets neither `to` nor `period`. For example 7d, 2w, 1m, or eom.",
					control: {
						type: "text",
						key: "defaultPeriod",
						placeholder: DEFAULT_SETTINGS.defaultPeriod,
						// A typo here would break every block relying on the default, with
						// an error naming an option the user never wrote.
						validate: (value: string) =>
							isValidPeriod(value) ? undefined : `"${value}" is not a period. Try 7d, 2w, 1m or eom.`,
					},
				},
				{ name: "24-hour time", control: { type: "toggle", key: "use24HourTime" } },
				{
					name: "Date heading format",
					desc: "Moment format for date group headings. Today, Tomorrow and Yesterday are always named. Blocks override it with `heading-format`.",
					control: { type: "text", key: "dateHeadingFormat", placeholder: DEFAULT_SETTINGS.dateHeadingFormat },
				},
				{
					name: "Inline date format",
					desc: "Moment format for the `date` field in list and table views. Blocks override it with `date-format`.",
					control: { type: "text", key: "tableDateFormat", placeholder: DEFAULT_SETTINGS.tableDateFormat },
				},
				{ name: "Hide declined events", control: { type: "toggle", key: "hideDeclined" } },
				{
					name: "Hidden events",
					desc: "One title pattern per line, hidden in every block. `EOD` matches that title exactly, `Start of *` matches a prefix, `*EOD*` matches anywhere, and `/regex/` is a regular expression. Blocks add more with `hide-titles`.",
					aliases: ["filter", "exclude", "ignore", "mute"],
					control: {
						type: "textarea",
						key: "hiddenTitles",
						placeholder: "EOD\nStart of *\n*lunch*",
					},
				},
				{
					name: "Description length",
					desc: "Characters shown before an event description is truncated. 0 hides descriptions. Only applies where `show: description` is set.",
					control: { type: "number", key: "descriptionLength", min: 0, step: 10 },
				},
			],
		};
	}

	private meetingNotesGroup(): SettingDefinitionGroup {
		const hasTemplater = templaterAvailable(this.app);
		const hasQuickAdd = quickAddAvailable(this.app);
		const types = this.plugin.settings.noteTypes;

		const typeOptions: Record<string, string> = { "": types.length ? "First in the list" : "Built-in" };
		for (const type of types) typeOptions[type.id] = type.name;

		return {
			type: "group",
			heading: "Meeting notes",
			items: [
				{
					name: "Detected plugins",
					desc: `Templater ${hasTemplater ? "yes" : "no"} · QuickAdd ${hasQuickAdd ? "yes" : "no"}. Placeholders such as {{title}} and {{date:YYYY-MM-DD}} work in folders, filenames and templates.`,
					searchable: false,
				},
				{
					name: "Show the note link by default",
					desc: "Adds the Create/Open meeting note link to every block. Blocks override with `meeting-note`.",
					control: { type: "toggle", key: "showMeetingNoteLink" },
				},
				{
					name: "Default folder",
					desc: "Where new meeting notes go. Leave empty for the vault root. Placeholders are allowed, which is why this is free text rather than a folder picker.",
					control: { type: "text", key: "noteFolder", placeholder: "Meetings" },
				},
				{
					name: "Default filename",
					control: { type: "text", key: "noteFilenameFormat", placeholder: DEFAULT_SETTINGS.noteFilenameFormat },
				},
				{
					name: "Run Templater on new notes",
					desc: "Processes <% %> commands after a note is created. Applies to the built-in mode only.",
					control: { type: "toggle", key: "runTemplaterOnCreate", disabled: !hasTemplater },
				},
				{
					name: "Default note type",
					desc: "Used when a block does not name one with `note-type`.",
					control: { type: "dropdown", key: "defaultNoteType", options: typeOptions },
				},
			],
		};
	}

	private noteTypesList(): SettingDefinitionList {
		const types = this.plugin.settings.noteTypes;
		const choices = quickAddChoices(this.app);

		return {
			type: "list",
			heading: "Note types",
			emptyState: "None yet — the built-in template is used. Add a type to use Templater or QuickAdd.",
			addItem: {
				name: "Add note type",
				action: () => {
					this.plugin.settings.noteTypes.push({
						id: crypto.randomUUID(),
						name: `Note type ${this.plugin.settings.noteTypes.length + 1}`,
						mode: "builtin",
						openAfterCreate: true,
					});
					void this.plugin.saveSettings().then(() => this.update());
				},
			},
			onDelete: (index: number) => {
				const type = types[index];
				if (!type) return;
				this.plugin.settings.noteTypes = types.filter((entry) => entry.id !== type.id);
				if (this.plugin.settings.defaultNoteType === type.id) this.plugin.settings.defaultNoteType = "";
				void this.plugin.saveSettings().then(() => {
					this.plugin.refreshAllBlocks();
					this.update();
				});
			},
			items: types.map((type): SettingDefinitionPage => {
				const key = (field: string) => `${NOTE_TYPE_KEY_PREFIX}${type.id}:${field}`;
				const isQuickAdd = () => this.noteType(type.id)?.mode === "quickadd";
				const usesTemplate = () => this.noteType(type.id)?.mode !== "quickadd";

				const choiceOptions: Record<string, string> = { "": "Select a choice…" };
				for (const choice of choices) choiceOptions[choice.name] = `${choice.label} · ${choice.type}`;
				// A choice renamed or deleted in QuickAdd must stay selectable, or opening
				// this page would silently discard it.
				if (type.quickAddChoice && !choices.some((c) => c.name === type.quickAddChoice)) {
					choiceOptions[type.quickAddChoice] = `${type.quickAddChoice} · missing from QuickAdd`;
				}

				return {
					type: "page",
					name: type.name,
					desc: `${type.mode}${type.folder ? ` · ${type.folder}` : ""}`,
					displayValue: type.mode,
					items: [
						{
							name: "Name",
							desc: "What `note-type` matches against in a block.",
							control: { type: "text", key: key("name") },
						},
						{
							name: "Mode",
							control: {
								type: "dropdown",
								key: key("mode"),
								options: {
									builtin: "Built-in (template file, optional Templater pass)",
									templater: "Templater — create from template",
									quickadd: "QuickAdd — run a choice",
								},
							},
						},
						{
							name: "QuickAdd choice",
							desc: choices.length
								? "Event data arrives as {{VALUE:title}}, {{VALUE:date}}, and so on."
								: "QuickAdd has no choices configured, or is not enabled.",
							visible: isQuickAdd,
							control: { type: "dropdown", key: key("quickAddChoice"), options: choiceOptions },
						},
						{
							name: "Template file",
							desc: "Optional for the built-in mode; required for Templater. Its {{placeholders}} are filled in by the built-in mode only.",
							visible: usesTemplate,
							control: {
								type: "file",
								key: key("templatePath"),
								placeholder: "Templates/Meeting.md",
								filter: (file: TFile) => file.extension === "md",
							},
						},
						{
							name: "Folder",
							desc: "Overrides the default folder for this type. Ignored in QuickAdd mode, which owns its own naming.",
							control: { type: "text", key: key("folder"), placeholder: this.plugin.settings.noteFolder || "vault root" },
						},
						{
							name: "Filename",
							desc: "Overrides the default filename format for this type.",
							control: {
								type: "text",
								key: key("filenameFormat"),
								placeholder: this.plugin.settings.noteFilenameFormat,
							},
						},
						{ name: "Open after creating", control: { type: "toggle", key: key("openAfterCreate") } },
					],
				};
			}),
		};
	}

	private syncingGroup(): SettingDefinitionGroup {
		return {
			type: "group",
			heading: "Syncing",
			items: [
				{
					name: "Cache lifetime",
					desc: "Seconds an API response is reused before Google is queried again. 0 re-queries on every render.",
					control: { type: "number", key: "cacheTtl", min: 0, step: 30 },
				},
				{
					name: "Auto-refresh",
					desc: "Seconds between automatic refreshes of open blocks. 0 disables it. Blocks override with `refresh`.",
					control: {
						type: "number",
						key: "autoRefresh",
						min: 0,
						step: 30,
						// Mirrors the clamp parseQuery applies, so the field cannot promise 5s.
						validate: (value: number) =>
							value === 0 || value >= 30 ? undefined : "Use 0 to disable, or at least 30 seconds.",
					},
				},
			],
		};
	}
}
