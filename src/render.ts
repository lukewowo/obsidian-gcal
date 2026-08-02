import { Menu, Notice, setIcon } from "obsidian";
import type { Moment } from "./moment-shim";
import { dayHeading, formatDuration, formatTime, timeLabel as eventTimeLabel } from "./dates";
import type { GCalQuery } from "./query";
import type { CalEvent, Field } from "./types";

/**
 * How the renderer reaches meeting-note behaviour without depending on the vault.
 * `main.ts` supplies the implementation.
 */
export interface NoteActions {
	/** Names of every configured type, for the context menu. */
	typeNames(): string[];
	/** Path of the note already linked to this event, if there is one. */
	existingPath(event: CalEvent, typeName?: string): string | null;
	openOrCreate(event: CalEvent, typeName?: string): void;
}

interface Group {
	key: string;
	label: string;
	color?: string;
	events: CalEvent[];
}

const FIELD_LABELS: Record<Field, string> = {
	date: "Date",
	day: "Day",
	time: "Time",
	start: "Start",
	end: "End",
	duration: "Length",
	title: "Event",
	calendar: "Calendar",
	account: "Account",
	location: "Location",
	description: "Notes",
	attendees: "Guests",
	organizer: "Organiser",
	status: "Status",
	response: "RSVP",
	link: "Link",
	note: "Note",
};

const FIELD_ICONS: Partial<Record<Field, string>> = {
	location: "map-pin",
	description: "align-left",
	attendees: "users",
	organizer: "user",
	calendar: "calendar",
	account: "at-sign",
	duration: "hourglass",
	response: "check-circle",
	status: "info",
	note: "file-pen-line",
};

function timeLabel(event: CalEvent, query: GCalQuery): string {
	return eventTimeLabel(event, query.use24HourTime);
}

/** Label and icon for the note action, which depends on whether the note exists yet. */
function noteState(event: CalEvent, query: GCalQuery, notes: NoteActions | undefined) {
	const existing = notes?.existingPath(event, query.noteType) ?? null;
	return {
		exists: Boolean(existing),
		label: existing ? "Open meeting note" : "Create meeting note",
		short: existing ? "Open" : "Create",
		tooltip: existing ?? undefined,
	};
}

function attendeeLabel(event: CalEvent): string | null {
	const guests = event.attendees.filter((attendee) => !attendee.resource && !attendee.self);
	if (guests.length === 0) return null;
	const accepted = guests.filter((guest) => guest.response === "accepted").length;
	const named = guests
		.slice(0, 3)
		.map((guest) => guest.name ?? guest.email ?? "unknown")
		.join(", ");
	const overflow = guests.length > 3 ? ` +${guests.length - 3}` : "";
	return `${named}${overflow} · ${accepted}/${guests.length} yes`;
}

function truncate(text: string, max: number): string {
	// A length of zero means show none of it — the opposite of "no limit".
	if (max <= 0) return "";
	if (text.length <= max) return text;
	return `${text.slice(0, max).trimEnd()}…`;
}

/** Plain-text value for a field, used by list and table views. */
function fieldText(event: CalEvent, field: Field, query: GCalQuery): string {
	switch (field) {
		case "date":
			return event.start.format(query.tableDateFormat);
		case "day":
			return event.start.format("ddd");
		case "time":
			return timeLabel(event, query);
		case "start":
			return event.allDay ? "all day" : formatTime(event.start, query.use24HourTime);
		case "end":
			return event.allDay ? "" : formatTime(event.end, query.use24HourTime);
		case "duration":
			return formatDuration(event.start, event.end, event.allDay);
		case "title":
			return event.title;
		case "calendar":
			return event.calendarName;
		case "account":
			return event.accountLabel;
		case "location":
			return event.location ?? "";
		case "description":
			return event.description ? truncate(event.description.replace(/\n+/g, " "), query.descriptionLength) : "";
		case "attendees":
			return attendeeLabel(event) ?? "";
		case "organizer":
			return event.organizer ?? "";
		case "status":
			return event.status ?? "";
		case "response":
			return event.selfResponse ?? "";
		case "link":
			return event.meetUrl ?? event.link ?? "";
		case "note":
			// Rendered as an action, not text.
			return "";
	}
}

function openExternal(url: string): void {
	window.open(url, "_blank");
}

function eventContextMenu(event: CalEvent, mouse: MouseEvent, query: GCalQuery, notes?: NoteActions): void {
	const menu = new Menu();

	if (notes) {
		const state = noteState(event, query, notes);
		menu.addItem((item) =>
			item
				.setTitle(state.label)
				.setIcon(state.exists ? "file-text" : "file-pen-line")
				.onClick(() => notes.openOrCreate(event, query.noteType))
		);

		// Offer the other configured types too, so one block can still reach them.
		if (!state.exists) {
			for (const name of notes.typeNames()) {
				if (name === query.noteType) continue;
				menu.addItem((item) =>
					item
						.setTitle(`New ${name}`)
						.setIcon("file-plus")
						.onClick(() => notes.openOrCreate(event, name))
				);
			}
		}
		menu.addSeparator();
	}

	if (event.link) {
		menu.addItem((item) => item.setTitle("Open in Google Calendar").setIcon("calendar").onClick(() => openExternal(event.link as string)));
	}
	if (event.meetUrl) {
		menu.addItem((item) => item.setTitle("Join video call").setIcon("video").onClick(() => openExternal(event.meetUrl as string)));
	}
	menu.addItem((item) =>
		item
			.setTitle("Copy title")
			.setIcon("copy")
			.onClick(async () => {
				await navigator.clipboard.writeText(event.title);
				new Notice("Event title copied");
			})
	);
	if (event.location) {
		menu.addItem((item) =>
			item
				.setTitle("Copy location")
				.setIcon("map-pin")
				.onClick(async () => {
					await navigator.clipboard.writeText(event.location as string);
					new Notice("Location copied");
				})
		);
	}
	menu.showAtMouseEvent(mouse);
}

function attachEventBehaviour(el: HTMLElement, event: CalEvent, query: GCalQuery, notes?: NoteActions): void {
	el.addEventListener("contextmenu", (mouse) => {
		mouse.preventDefault();
		eventContextMenu(event, mouse, query, notes);
	});
	if (event.link) {
		el.addClass("gcal-clickable");
		el.addEventListener("click", (mouse) => {
			if (mouse.defaultPrevented) return;
			openExternal(event.link as string);
		});
	}
}

function groupEvents(events: CalEvent[], query: GCalQuery): Group[] {
	if (query.group === "none") {
		return [{ key: "all", label: "", events }];
	}

	const groups = new Map<string, Group>();
	for (const event of events) {
		// Keyed on calendarKey, not calendarId, so the same shared calendar
		// subscribed by two accounts stays in two groups.
		const key =
			query.group === "calendar"
				? event.calendarKey
				: query.group === "account"
					? event.accountId
					: event.start.format("YYYY-MM-DD");

		let group = groups.get(key);
		if (!group) {
			group = {
				key,
				label:
					query.group === "calendar"
						? event.calendarName
						: query.group === "account"
							? event.accountLabel
							: dayHeading(event.start, query.dateHeadingFormat),
				color: query.group === "calendar" ? event.calendarColor : undefined,
				events: [],
			};
			groups.set(key, group);
		}
		group.events.push(event);
	}
	return [...groups.values()];
}

/** Anchor-styled button that runs an in-vault action rather than opening a URL. */
function createAction(parent: HTMLElement, cls: string, label: string, tooltip: string | undefined, run: () => void): void {
	const action = parent.createEl("a", { cls, text: label });
	action.setAttr("role", "button");
	if (tooltip) action.setAttr("aria-label", tooltip);
	action.addEventListener("click", (mouse) => {
		mouse.preventDefault();
		mouse.stopPropagation();
		run();
	});
}

function renderMetaLine(
	parent: HTMLElement,
	field: Field,
	text: string,
	event: CalEvent,
	query: GCalQuery,
	notes?: NoteActions
): void {
	if (field === "note" && !notes) return;

	const line = parent.createDiv({ cls: `gcal-meta gcal-meta-${field}` });
	const icon = FIELD_ICONS[field];
	if (icon) setIcon(line.createSpan({ cls: "gcal-meta-icon" }), icon);

	if (field === "note" && notes) {
		const state = noteState(event, query, notes);
		createAction(line, "gcal-meta-text gcal-link gcal-note-action", state.label, state.tooltip, () =>
			notes.openOrCreate(event, query.noteType)
		);
		return;
	}

	if (field === "link") {
		const url = event.meetUrl ?? event.link;
		if (!url) return;
		const anchor = line.createEl("a", {
			cls: "gcal-meta-text gcal-link",
			text: event.meetUrl ? "Join call" : "Open in Google Calendar",
			href: url,
		});
		anchor.addEventListener("click", (mouse) => {
			mouse.preventDefault();
			mouse.stopPropagation();
			openExternal(url);
		});
		return;
	}

	line.createSpan({ cls: "gcal-meta-text", text });
}

function renderAgenda(container: HTMLElement, events: CalEvent[], query: GCalQuery, notes?: NoteActions): void {
	// A date line is redundant under a date heading, but with any other grouping
	// it is the only thing saying which day an event falls on.
	const dateInHeading = query.group === "date";
	const metaFields = query.fields.filter(
		(field) => field !== "time" && field !== "title" && !(field === "date" && dateInHeading)
	);

	for (const group of groupEvents(events, query)) {
		const section = container.createDiv({ cls: "gcal-group" });
		if (group.label) {
			const heading = section.createDiv({ cls: "gcal-group-heading" });
			if (group.color) heading.createSpan({ cls: "gcal-dot" }).style.backgroundColor = group.color;
			heading.createSpan({ cls: "gcal-group-title", text: group.label });
			heading.createSpan({ cls: "gcal-group-count", text: String(group.events.length) });
		}

		const showTime = query.fields.includes("time");
		const list = section.createDiv({ cls: "gcal-agenda" });
		for (const event of group.events) {
			const row = list.createDiv({ cls: "gcal-event" });
			row.toggleClass("no-gutter", !showTime);
			row.toggleClass("is-all-day", event.allDay);
			row.toggleClass("is-declined", event.selfResponse === "declined");
			row.toggleClass("is-tentative", event.selfResponse === "tentative" || event.status === "tentative");
			row.style.setProperty("--gcal-event-color", event.calendarColor);

			if (showTime) {
				row.createDiv({ cls: "gcal-event-time", text: timeLabel(event, query) });
			}

			const body = row.createDiv({ cls: "gcal-event-body" });
			body.createDiv({ cls: "gcal-event-title", text: event.title });

			// `note` is an action with no text of its own; everything else needs a value.
			const willRender = (field: Field) => (field === "note" ? Boolean(notes) : Boolean(fieldText(event, field, query)));

			// Short metadata shares one wrapping row separated by bullets. A description
			// is prose and can run long, so it keeps a line to itself underneath.
			const inline = metaFields.filter((field) => field !== "description" && willRender(field));
			if (inline.length > 0) {
				const metaRow = body.createDiv({ cls: "gcal-meta-row" });
				for (const field of inline) {
					renderMetaLine(metaRow, field, fieldText(event, field, query), event, query, notes);
				}
			}
			for (const field of metaFields) {
				if (field !== "description" || !willRender(field)) continue;
				renderMetaLine(body, field, fieldText(event, field, query), event, query, notes);
			}

			attachEventBehaviour(row, event, query, notes);
		}
	}
}

function renderList(container: HTMLElement, events: CalEvent[], query: GCalQuery, notes?: NoteActions): void {
	for (const group of groupEvents(events, query)) {
		const section = container.createDiv({ cls: "gcal-group" });
		if (group.label) {
			section.createDiv({ cls: "gcal-group-heading" }).createSpan({ cls: "gcal-group-title", text: group.label });
		}

		const list = section.createEl("ul", { cls: "gcal-list" });
		for (const event of group.events) {
			const item = list.createEl("li", { cls: "gcal-list-item" });
			item.toggleClass("is-declined", event.selfResponse === "declined");
			item.createSpan({ cls: "gcal-dot" }).style.backgroundColor = event.calendarColor;

			for (const field of query.fields) {
				if (field === "note") {
					if (!notes) continue;
					const state = noteState(event, query, notes);
					createAction(item, "gcal-cell gcal-cell-note gcal-link", state.short, state.tooltip ?? state.label, () =>
						notes.openOrCreate(event, query.noteType)
					);
					continue;
				}
				const text = fieldText(event, field, query);
				if (!text) continue;
				item.createSpan({ cls: `gcal-cell gcal-cell-${field}`, text });
			}

			attachEventBehaviour(item, event, query, notes);
		}
	}
}

function renderTable(container: HTMLElement, events: CalEvent[], query: GCalQuery, notes?: NoteActions): void {
	const table = container.createEl("table", { cls: "gcal-table" });
	const head = table.createEl("thead").createEl("tr");
	for (const column of query.columns) {
		head.createEl("th", { cls: `gcal-col-${column}`, text: FIELD_LABELS[column] });
	}

	const body = table.createEl("tbody");
	for (const event of events) {
		const row = body.createEl("tr", { cls: "gcal-table-row" });
		row.toggleClass("is-declined", event.selfResponse === "declined");
		row.style.setProperty("--gcal-event-color", event.calendarColor);

		for (const column of query.columns) {
			const cell = row.createEl("td", { cls: `gcal-col-${column}` });
			if (column === "link") {
				const url = event.meetUrl ?? event.link;
				if (url) {
					const anchor = cell.createEl("a", { cls: "gcal-link", text: event.meetUrl ? "Join" : "Open", href: url });
					anchor.addEventListener("click", (mouse) => {
						mouse.preventDefault();
						mouse.stopPropagation();
						openExternal(url);
					});
				}
				continue;
			}
			if (column === "note") {
				if (notes) {
					const state = noteState(event, query, notes);
					createAction(cell, "gcal-link", state.short, state.tooltip ?? state.label, () =>
						notes.openOrCreate(event, query.noteType)
					);
				}
				continue;
			}
			if (column === "calendar") {
				cell.createSpan({ cls: "gcal-dot" }).style.backgroundColor = event.calendarColor;
			}
			cell.createSpan({ text: fieldText(event, column, query) });
		}

		attachEventBehaviour(row, event, query, notes);
	}
}

export interface ChromeOptions {
	warnings: string[];
	lastUpdated: Moment | null;
	onRefresh: () => void;
	notes?: NoteActions;
}

export function renderEvents(
	container: HTMLElement,
	events: CalEvent[],
	query: GCalQuery,
	chrome: ChromeOptions
): void {
	container.empty();
	container.addClass("gcal-block", `gcal-view-${query.view}`);

	for (const warning of chrome.warnings) {
		container.createDiv({ cls: "gcal-warning", text: warning });
	}

	if (events.length === 0) {
		container.createDiv({ cls: "gcal-empty", text: query.emptyMessage });
	} else if (query.view === "table") {
		renderTable(container, events, query, chrome.notes);
	} else if (query.view === "list") {
		renderList(container, events, query, chrome.notes);
	} else {
		renderAgenda(container, events, query, chrome.notes);
	}

	if (!query.showRefreshButton) return;

	const footer = container.createDiv({ cls: "gcal-footer" });
	if (chrome.lastUpdated) {
		footer.createSpan({ cls: "gcal-updated", text: `Updated ${chrome.lastUpdated.fromNow()}` });
	}
	const button = footer.createEl("button", { cls: "gcal-refresh", attr: { "aria-label": "Refresh events" } });
	setIcon(button, "refresh-cw");
	button.addEventListener("click", chrome.onRefresh);
}

export function renderMessage(
	container: HTMLElement,
	kind: "error" | "notice",
	title: string,
	detail?: string,
	action?: { label: string; onClick: () => void }
): void {
	container.empty();
	container.addClass("gcal-block");

	const box = container.createDiv({ cls: `gcal-message gcal-message-${kind}` });
	const heading = box.createDiv({ cls: "gcal-message-title" });
	setIcon(heading.createSpan({ cls: "gcal-message-icon" }), kind === "error" ? "alert-triangle" : "info");
	heading.createSpan({ text: title });
	if (detail) box.createDiv({ cls: "gcal-message-detail", text: detail });
	if (action) {
		const button = box.createEl("button", { cls: "gcal-message-action", text: action.label });
		button.addEventListener("click", action.onClick);
	}
}
