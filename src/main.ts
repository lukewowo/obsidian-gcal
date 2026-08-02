import {
	MarkdownRenderChild,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	moment,
	type MarkdownPostProcessorContext,
} from "obsidian";
import type { Moment } from "moment";
import { AuthError, GoogleAuth, authorize, revoke, type AuthConfig, type OAuthTokens } from "./auth";
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
	DEFAULT_SETTINGS,
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
		const config = existing
			? this.configFor(existing)
			: {
					clientId: this.settings.clientId.trim(),
					clientSecret: this.settings.clientSecret.trim(),
					port: this.settings.oauthPort,
				};

		try {
			const tokens = await authorize(config);
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
				"Add your OAuth client details in the plugin settings, then add an account.",
				{ label: "Add account", onClick: () => void this.plugin.addAccount().catch(() => undefined) }
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

class GCalSettingTab extends PluginSettingTab {
	constructor(private readonly plugin: GoogleCalendarAgendaPlugin) {
		super(plugin.app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		this.renderOAuthClient(containerEl);
		this.renderAccounts(containerEl);
		this.renderCalendars(containerEl);
		this.renderDefaults(containerEl);
		this.renderMeetingNotes(containerEl);
		this.renderPerformance(containerEl);
	}

	/**
	 * Numeric field that never shows a value different from the one stored.
	 * Typing is left alone until blur, when the box is redrawn from what was
	 * actually saved — so a clamped or rejected entry is visible, not silent.
	 */
	private addNumberField(
		setting: Setting,
		read: () => number,
		clamp: (value: number) => number,
		write: (value: number) => Promise<void>
	): void {
		setting.addText((text) => {
			text.inputEl.type = "number";
			text.setValue(String(read()));

			text.onChange(async (raw) => {
				const parsed = Number(raw.trim());
				// Mid-edit rubbish is ignored rather than coerced; blur reconciles it.
				if (raw.trim() === "" || !Number.isFinite(parsed)) return;
				await write(clamp(parsed));
			});

			text.inputEl.addEventListener("blur", () => text.setValue(String(read())));
		});
	}

	private renderMeetingNotes(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Meeting notes").setHeading();

		const hasTemplater = templaterAvailable(this.app);
		const hasQuickAdd = quickAddAvailable(this.app);
		containerEl.createDiv({
			cls: "setting-item-description gcal-settings-intro",
			text:
				`Detected: Templater ${hasTemplater ? "yes" : "no"} · QuickAdd ${hasQuickAdd ? "yes" : "no"}. ` +
				"Placeholders such as {{title}} and {{date:YYYY-MM-DD}} work in folders, filenames and templates.",
		});

		new Setting(containerEl)
			.setName("Show the note link by default")
			.setDesc("Adds the Create/Open meeting note link to every block. Blocks can override with `meeting-note`.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showMeetingNoteLink).onChange(async (value) => {
					this.plugin.settings.showMeetingNoteLink = value;
					await this.plugin.saveSettings();
					this.plugin.refreshAllBlocks();
				})
			);

		new Setting(containerEl)
			.setName("Default folder")
			.setDesc("Where new meeting notes go. Leave empty for the vault root. Placeholders are allowed.")
			.addText((text) =>
				text
					.setPlaceholder("Meetings")
					.setValue(this.plugin.settings.noteFolder)
					.onChange(async (value) => {
						this.plugin.settings.noteFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Default filename")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.noteFilenameFormat)
					.setValue(this.plugin.settings.noteFilenameFormat)
					.onChange(async (value) => {
						this.plugin.settings.noteFilenameFormat = value.trim() || DEFAULT_SETTINGS.noteFilenameFormat;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Run Templater on new notes")
			.setDesc("Processes <% %> commands after a note is created. Applies to the built-in mode only.")
			.setDisabled(!hasTemplater)
			.addToggle((toggle) =>
				// Setting.setDisabled only greys the row; the control needs disabling too.
				toggle.setDisabled(!hasTemplater).setValue(this.plugin.settings.runTemplaterOnCreate).onChange(async (value) => {
					this.plugin.settings.runTemplaterOnCreate = value;
					await this.plugin.saveSettings();
				})
			);

		const types = this.plugin.settings.noteTypes;
		new Setting(containerEl)
			.setName("Note types")
			.setDesc(
				types.length
					? "Blocks pick one with `note-type`. The default is used when they do not."
					: "None yet — the built-in template is used. Add a type to use Templater or QuickAdd."
			)
			.addDropdown((dropdown) => {
				dropdown.addOption("", types.length ? "First in the list" : "Built-in");
				for (const type of types) dropdown.addOption(type.id, type.name);
				dropdown.setValue(this.plugin.settings.defaultNoteType).onChange(async (value) => {
					this.plugin.settings.defaultNoteType = value;
					await this.plugin.saveSettings();
				});
			})
			.addButton((button) =>
				button.setButtonText("Add type").onClick(async () => {
					this.plugin.settings.noteTypes.push({
						id: crypto.randomUUID(),
						name: `Note type ${this.plugin.settings.noteTypes.length + 1}`,
						mode: "builtin",
						openAfterCreate: true,
					});
					await this.plugin.saveSettings();
					this.display();
				})
			);

		for (const type of types) this.renderNoteType(containerEl, type);
	}

	/** A picker of QuickAdd's own choices, falling back to free text if it cannot read them. */
	private renderQuickAddChoice(containerEl: HTMLElement, type: NoteType): void {
		const choices = quickAddChoices(this.app);
		const setting = new Setting(containerEl)
			.setName("QuickAdd choice")
			.setDesc("Event data arrives as {{VALUE:title}}, {{VALUE:date}}, and so on.");

		if (choices.length === 0) {
			setting.setDesc(
				quickAddAvailable(this.app)
					? "QuickAdd has no choices configured yet. Add one in QuickAdd, then reopen this tab."
					: "QuickAdd is not installed or not enabled — the name is stored, but nothing will run."
			);
			setting.addText((text) =>
				text
					.setPlaceholder("Meeting note")
					.setValue(type.quickAddChoice ?? "")
					.onChange(async (value) => {
						type.quickAddChoice = value.trim() || undefined;
						await this.plugin.saveSettings();
					})
			);
			return;
		}

		setting.addDropdown((dropdown) => {
			dropdown.addOption("", "Select a choice…");
			for (const choice of choices) dropdown.addOption(choice.name, `${choice.label} · ${choice.type}`);

			// A choice renamed or deleted inside QuickAdd must stay visible, or opening
			// this tab would silently discard it.
			const current = type.quickAddChoice;
			if (current && !choices.some((choice) => choice.name === current)) {
				dropdown.addOption(current, `${current} · missing from QuickAdd`);
			}

			dropdown.setValue(current ?? "").onChange(async (value) => {
				type.quickAddChoice = value || undefined;
				await this.plugin.saveSettings();
			});
		});

		setting.addExtraButton((button) =>
			button
				.setIcon("refresh-cw")
				.setTooltip("Reload the list from QuickAdd")
				.onClick(() => this.display())
		);
	}

	/** Free-text path plus a picker over the configured template folders. */
	private renderTemplatePath(containerEl: HTMLElement, type: NoteType): void {
		const candidates = templateCandidates(this.app);
		const setting = new Setting(containerEl)
			.setName("Template file")
			.setDesc(
				type.mode === "templater"
					? "Path to the Templater template. Templater owns the processing."
					: "Optional. A template whose {{placeholders}} get filled in. Leave empty for the built-in body."
			);

		let field: import("obsidian").TextComponent | null = null;
		setting.addText((text) => {
			field = text;
			text
				.setPlaceholder("Templates/Meeting.md")
				.setValue(type.templatePath ?? "")
				.onChange(async (value) => {
					type.templatePath = value.trim() || undefined;
					await this.plugin.saveSettings();
				});
		});

		if (candidates.length === 0) return;

		// With one template folder the prefix is noise; with several it is the only
		// thing telling two same-named templates apart.
		const folders = new Set(candidates.map((path) => path.slice(0, path.lastIndexOf("/"))));
		const labelFor = (path: string) => (folders.size > 1 ? path : (path.split("/").pop() ?? path));

		setting.addDropdown((dropdown) => {
			dropdown.addOption("", "Pick…");
			for (const path of candidates) dropdown.addOption(path, labelFor(path));
			dropdown.setValue("").onChange(async (value) => {
				if (!value) return;
				type.templatePath = value;
				field?.setValue(value);
				dropdown.setValue("");
				await this.plugin.saveSettings();
			});
		});
	}

	private renderNoteType(containerEl: HTMLElement, type: NoteType): void {
		const details = containerEl.createEl("details", { cls: "gcal-account-advanced gcal-note-type" });
		details.createEl("summary", { text: `${type.name} — ${type.mode}` });

		new Setting(details)
			.setName("Name")
			.setDesc("What `note-type` matches against.")
			.addText((text) =>
				text.setValue(type.name).onChange(async (value) => {
					type.name = value.trim() || type.id;
					await this.plugin.saveSettings();
					this.plugin.refreshAllBlocks();
				})
			);

		new Setting(details)
			.setName("Mode")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						builtin: "Built-in (template file, optional Templater pass)",
						templater: "Templater — create from template",
						quickadd: "QuickAdd — run a choice",
					})
					.setValue(type.mode)
					.onChange(async (value) => {
						type.mode = value as NoteType["mode"];
						await this.plugin.saveSettings();
						this.display();
					})
			);

		if (type.mode === "quickadd") {
			this.renderQuickAddChoice(details, type);
		} else {
			this.renderTemplatePath(details, type);
		}

		new Setting(details)
			.setName("Folder")
			.setDesc("Overrides the default folder for this type.")
			.addText((text) =>
				text
					.setPlaceholder(this.plugin.settings.noteFolder || "vault root")
					.setValue(type.folder ?? "")
					.onChange(async (value) => {
						type.folder = value.trim() || undefined;
						await this.plugin.saveSettings();
					})
			);

		new Setting(details)
			.setName("Filename")
			.setDesc("Overrides the default filename format for this type.")
			.addText((text) =>
				text
					.setPlaceholder(this.plugin.settings.noteFilenameFormat)
					.setValue(type.filenameFormat ?? "")
					.onChange(async (value) => {
						type.filenameFormat = value.trim() || undefined;
						await this.plugin.saveSettings();
					})
			);

		new Setting(details)
			.setName("Open after creating")
			.addToggle((toggle) =>
				toggle.setValue(type.openAfterCreate).onChange(async (value) => {
					type.openAfterCreate = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(details).addButton((button) =>
			button
				.setButtonText("Remove this type")
				.setWarning()
				.onClick(async () => {
					this.plugin.settings.noteTypes = this.plugin.settings.noteTypes.filter((entry) => entry.id !== type.id);
					if (this.plugin.settings.defaultNoteType === type.id) this.plugin.settings.defaultNoteType = "";
					await this.plugin.saveSettings();
					this.plugin.refreshAllBlocks();
					this.display();
				})
		);
	}

	private renderOAuthClient(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("OAuth client").setHeading();

		const intro = containerEl.createDiv({ cls: "setting-item-description gcal-settings-intro" });
		intro.createSpan({
			text: "Create an OAuth client of type “Desktop app” in a Google Cloud project with the Calendar API enabled. One client can serve every account you add. ",
		});
		const href = "https://console.cloud.google.com/apis/credentials";
		const link = intro.createEl("a", { text: "Open Google Cloud credentials", href });
		link.addEventListener("click", (mouse) => {
			mouse.preventDefault();
			window.open(href, "_blank");
		});

		new Setting(containerEl).setName("Client ID").addText((text) =>
			text
				.setPlaceholder("xxxxx.apps.googleusercontent.com")
				.setValue(this.plugin.settings.clientId)
				.onChange(async (value) => {
					this.plugin.settings.clientId = value;
					await this.plugin.saveSettings();
				})
		);

		new Setting(containerEl).setName("Client secret").addText((text) => {
			text.inputEl.type = "password";
			text
				.setPlaceholder("GOCSPX-…")
				.setValue(this.plugin.settings.clientSecret)
				.onChange(async (value) => {
					this.plugin.settings.clientSecret = value;
					await this.plugin.saveSettings();
				});
		});

		// Only relevant to a "Web application" client, which the setup guide tells
		// people not to create — so it stays out of the main flow.
		const advanced = containerEl.createEl("details", { cls: "gcal-account-advanced" });
		advanced.createEl("summary", { text: "Advanced" });
		if (this.plugin.settings.oauthPort !== 0) advanced.setAttr("open", "");

		this.addNumberField(
			new Setting(advanced)
				.setName("Callback port")
				.setDesc(
					"0 lets the OS pick a free port each time, which is right for a Desktop app client. Set a fixed port only if you created a “Web application” client and registered http://127.0.0.1:PORT with it."
				),
			() => this.plugin.settings.oauthPort,
			(value) => (Number.isInteger(value) && value >= 0 && value <= 65535 ? value : 0),
			async (value) => {
				this.plugin.settings.oauthPort = value;
				await this.plugin.saveSettings();
			}
		);
	}

	private renderAccounts(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("Accounts")
			.setDesc("Connect as many Google accounts as you like. Each keeps its own token.")
			.setHeading()
			.addButton((button) =>
				button
					.setButtonText("Add account")
					.setCta()
					.onClick(async () => {
						button.setDisabled(true);
						try {
							await this.plugin.addAccount();
						} catch {
							/* addAccount already showed a Notice. */
						}
						this.display();
					})
			);

		if (this.plugin.settings.accounts.length === 0) {
			containerEl.createDiv({
				cls: "setting-item-description",
				text: "No accounts yet. Fill in the OAuth client above, then use Add account.",
			});
			return;
		}

		for (const account of this.plugin.settings.accounts) {
			const connected = Boolean(account.tokens?.refreshToken);
			const calendarCount = this.plugin.settings.knownCalendars.filter(
				(calendar) => calendar.accountId === account.id
			).length;

			const setting = new Setting(containerEl)
				.setName(account.label)
				.setDesc(
					[account.id === account.label ? null : account.id, connected ? `${calendarCount} calendars` : "not connected"]
						.filter(Boolean)
						.join(" · ")
				);

			setting.addText((text) =>
				text
					.setPlaceholder("Label")
					.setValue(account.label)
					.onChange(async (value) => {
						await this.plugin.renameAccount(account.id, value.trim() || account.id);
					})
			);

			setting.addButton((button) =>
				button
					.setButtonText(connected ? "Reconnect" : "Connect")
					.setTooltip("Run the Google consent flow again for this account")
					.onClick(async () => {
						button.setDisabled(true);
						try {
							await this.plugin.addAccount(account);
						} catch {
							/* Notice already shown. */
						}
						this.display();
					})
			);

			setting.addExtraButton((button) =>
				button
					.setIcon("trash-2")
					.setTooltip("Remove this account")
					.onClick(async () => {
						await this.plugin.removeAccount(account.id);
						new Notice(`Removed ${account.label}`);
						this.display();
					})
			);

			// Workspaces that block outside apps need their own client; everyone else
			// can ignore this.
			const advanced = containerEl.createEl("details", { cls: "gcal-account-advanced" });
			advanced.createEl("summary", { text: "Use a separate OAuth client for this account" });
			if (account.clientId || account.clientSecret) advanced.setAttr("open", "");

			new Setting(advanced).setName("Client ID").addText((text) =>
				text
					.setPlaceholder("Falls back to the shared client")
					.setValue(account.clientId ?? "")
					.onChange(async (value) => {
						account.clientId = value.trim() || undefined;
						await this.plugin.saveSettings();
					})
			);

			new Setting(advanced).setName("Client secret").addText((text) => {
				text.inputEl.type = "password";
				text
					.setPlaceholder("Falls back to the shared client")
					.setValue(account.clientSecret ?? "")
					.onChange(async (value) => {
						account.clientSecret = value.trim() || undefined;
						await this.plugin.saveSettings();
					});
			});
		}
	}

	private renderCalendars(containerEl: HTMLElement): void {
		new Setting(containerEl)
			.setName("Calendars")
			.setDesc("Blocks that do not name calendars use the ones enabled here. With none enabled, all calendars are queried.")
			.setHeading()
			.addButton((button) =>
				button
					.setButtonText("Reload list")
					.setDisabled(!this.plugin.hasAnyAccount())
					.onClick(async () => {
						button.setDisabled(true);
						try {
							const { errors } = await this.plugin.reloadCalendars();
							new Notice(errors.length ? `Calendar list updated with errors: ${errors.join("; ")}` : "Calendar list updated");
						} catch (error) {
							new Notice(`Google Calendar: ${describeError(error)}`, 10000);
						}
						this.display();
					})
			);

		const calendars = this.plugin.settings.knownCalendars;
		if (calendars.length === 0) {
			containerEl.createDiv({
				cls: "setting-item-description",
				text: this.plugin.hasAnyAccount() ? "No calendars loaded yet — use Reload list." : "Add an account first.",
			});
			return;
		}

		const byAccount = new Map<string, CalendarInfo[]>();
		for (const calendar of calendars) {
			const bucket = byAccount.get(calendar.accountId);
			if (bucket) bucket.push(calendar);
			else byAccount.set(calendar.accountId, [calendar]);
		}

		for (const [, group] of byAccount) {
			containerEl.createDiv({ cls: "gcal-account-heading", text: group[0].accountLabel });

			for (const calendar of group) {
				const setting = new Setting(containerEl).setName(calendar.name).setDesc(calendar.id);
				setting.nameEl.prepend(
					createSpan({ cls: "gcal-dot", attr: { style: `background-color: ${calendar.color}` } })
				);
				setting.addToggle((toggle) =>
					toggle.setValue(this.plugin.settings.defaultCalendars.includes(calendar.key)).onChange(async (value) => {
						const selected = new Set(this.plugin.settings.defaultCalendars);
						if (value) selected.add(calendar.key);
						else selected.delete(calendar.key);
						this.plugin.settings.defaultCalendars = [...selected];
						await this.plugin.saveSettings();
						this.plugin.refreshAllBlocks();
					})
				);
			}
		}
	}

	private renderDefaults(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Defaults").setHeading();

		new Setting(containerEl)
			.setName("View")
			.setDesc("Used when a block omits `view`.")
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({ agenda: "Agenda", list: "List", table: "Table" })
					.setValue(this.plugin.settings.defaultView)
					.onChange(async (value) => {
						this.plugin.settings.defaultView = value as GCalSettings["defaultView"];
						await this.plugin.saveSettings();
						this.plugin.refreshAllBlocks();
					})
			);

		new Setting(containerEl)
			.setName("Period")
			.setDesc("How far ahead to look when a block sets neither `to` nor `period`. For example 7d, 2w, 1m, or eom.")
			.addText((text) => {
				text.setValue(this.plugin.settings.defaultPeriod);

				text.onChange(async (value) => {
					// A typo here would break every block that relies on the default,
					// with an error naming an option the user never wrote.
					if (!isValidPeriod(value)) return;
					this.plugin.settings.defaultPeriod = value.trim();
					await this.plugin.saveSettings();
					this.plugin.refreshAllBlocks();
				});

				text.inputEl.addEventListener("blur", () => {
					if (isValidPeriod(text.getValue())) return;
					new Notice(`"${text.getValue()}" is not a period — keeping ${this.plugin.settings.defaultPeriod}`);
					text.setValue(this.plugin.settings.defaultPeriod);
				});
			});

		new Setting(containerEl).setName("24-hour time").addToggle((toggle) =>
			toggle.setValue(this.plugin.settings.use24HourTime).onChange(async (value) => {
				this.plugin.settings.use24HourTime = value;
				await this.plugin.saveSettings();
				this.plugin.refreshAllBlocks();
			})
		);

		new Setting(containerEl)
			.setName("Date heading format")
			.setDesc("Moment format for date group headings. Today, Tomorrow and Yesterday are always named. Blocks override it with `heading-format`.")
			.addText((text) =>
				text.setValue(this.plugin.settings.dateHeadingFormat).onChange(async (value) => {
					this.plugin.settings.dateHeadingFormat = value.trim() || DEFAULT_SETTINGS.dateHeadingFormat;
					await this.plugin.saveSettings();
					this.plugin.refreshAllBlocks();
				})
			);

		new Setting(containerEl)
			.setName("Inline date format")
			.setDesc("Moment format for the `date` field in list and table views. Blocks override it with `date-format`.")
			.addText((text) =>
				text.setValue(this.plugin.settings.tableDateFormat).onChange(async (value) => {
					this.plugin.settings.tableDateFormat = value.trim() || DEFAULT_SETTINGS.tableDateFormat;
					await this.plugin.saveSettings();
					this.plugin.refreshAllBlocks();
				})
			);

		new Setting(containerEl).setName("Hide declined events").addToggle((toggle) =>
			toggle.setValue(this.plugin.settings.hideDeclined).onChange(async (value) => {
				this.plugin.settings.hideDeclined = value;
				await this.plugin.saveSettings();
				this.plugin.refreshAllBlocks();
			})
		);

		this.addNumberField(
			new Setting(containerEl)
				.setName("Description length")
				.setDesc("Characters shown before an event description is truncated. 0 hides descriptions. Only applies where `show: description` is set."),
			() => this.plugin.settings.descriptionLength,
			(value) => Math.max(0, Math.floor(value)),
			async (value) => {
				this.plugin.settings.descriptionLength = value;
				await this.plugin.saveSettings();
				this.plugin.refreshAllBlocks();
			}
		);
	}

	private renderPerformance(containerEl: HTMLElement): void {
		new Setting(containerEl).setName("Syncing").setHeading();

		this.addNumberField(
			new Setting(containerEl)
				.setName("Cache lifetime")
				.setDesc("Seconds an API response is reused before Google is queried again. 0 re-queries on every render."),
			() => this.plugin.settings.cacheTtl,
			(value) => Math.max(0, Math.floor(value)),
			async (value) => {
				this.plugin.settings.cacheTtl = value;
				await this.plugin.saveSettings();
			}
		);

		this.addNumberField(
			new Setting(containerEl)
				.setName("Auto-refresh")
				.setDesc("Seconds between automatic refreshes of open blocks. 0 disables it, and anything above 0 is held to a 30 second minimum. Blocks can override with `refresh`."),
			() => this.plugin.settings.autoRefresh,
			// Matches the clamp parseQuery applies, so the box cannot promise 5s.
			(value) => (value <= 0 ? 0 : Math.max(30, Math.floor(value))),
			async (value) => {
				this.plugin.settings.autoRefresh = value;
				await this.plugin.saveSettings();
				this.plugin.refreshAllBlocks();
			}
		);
	}
}
