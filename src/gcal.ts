import { moment, requestUrl } from "obsidian";
import type { Moment } from "moment";
import { AuthError, type GoogleAuth } from "./auth";
import { calendarKey } from "./settings";
import type { Attendee, CalEvent, CalendarInfo } from "./types";

const API_BASE = "https://www.googleapis.com/calendar/v3";
const PAGE_SIZE = 250;
/** Guard against a runaway range pulling an entire calendar history. */
const MAX_PAGES = 10;

export class GCalError extends Error {}

interface RawDate {
	date?: string;
	dateTime?: string;
	timeZone?: string;
}

interface RawEvent {
	id?: string;
	summary?: string;
	description?: string;
	location?: string;
	htmlLink?: string;
	hangoutLink?: string;
	status?: string;
	start?: RawDate;
	end?: RawDate;
	organizer?: { email?: string; displayName?: string; self?: boolean };
	attendees?: Array<{
		email?: string;
		displayName?: string;
		responseStatus?: string;
		self?: boolean;
		optional?: boolean;
		resource?: boolean;
	}>;
	conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
	recurringEventId?: string;
}

interface RawCalendarListEntry {
	id?: string;
	summary?: string;
	summaryOverride?: string;
	backgroundColor?: string;
	primary?: boolean;
	timeZone?: string;
	deleted?: boolean;
}

export interface EventQuery {
	calendarId: string;
	timeMin: Moment;
	timeMax: Moment;
	/** Google full-text search across title, description, location and attendees. */
	search?: string;
}

function stripHtml(html: string): string {
	return html
		.replace(/<br\s*\/?>/gi, "\n")
		.replace(/<\/(p|div|li|tr)>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.replace(/&nbsp;/g, " ")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

function meetUrlOf(raw: RawEvent): string | undefined {
	if (raw.hangoutLink) return raw.hangoutLink;
	const video = raw.conferenceData?.entryPoints?.find((entry) => entry.entryPointType === "video");
	return video?.uri;
}

function toAttendee(raw: NonNullable<RawEvent["attendees"]>[number]): Attendee {
	return {
		email: raw.email,
		name: raw.displayName,
		response: raw.responseStatus,
		self: Boolean(raw.self),
		optional: Boolean(raw.optional),
		resource: Boolean(raw.resource),
	};
}

function normaliseEvent(raw: RawEvent, calendar: CalendarInfo): CalEvent | null {
	const startRaw = raw.start;
	const endRaw = raw.end;
	if (!startRaw || !endRaw) return null;

	const allDay = Boolean(startRaw.date);
	const start = allDay ? moment(startRaw.date, "YYYY-MM-DD").startOf("day") : moment(startRaw.dateTime);
	// Google's all-day end date is exclusive; pull it back so display maths is inclusive.
	const end = allDay
		? moment(endRaw.date, "YYYY-MM-DD").subtract(1, "day").endOf("day")
		: moment(endRaw.dateTime);
	if (!start.isValid() || !end.isValid()) return null;

	const attendees = (raw.attendees ?? []).map(toAttendee);
	const organizer = raw.organizer?.displayName ?? raw.organizer?.email;

	return {
		id: raw.id ?? `${calendar.key}:${start.valueOf()}`,
		calendarKey: calendar.key,
		calendarId: calendar.id,
		calendarName: calendar.name,
		calendarColor: calendar.color,
		accountId: calendar.accountId,
		accountLabel: calendar.accountLabel,
		title: raw.summary?.trim() || "(no title)",
		start,
		end,
		allDay,
		location: raw.location?.trim() || undefined,
		description: raw.description ? stripHtml(raw.description) || undefined : undefined,
		link: raw.htmlLink,
		meetUrl: meetUrlOf(raw),
		status: raw.status,
		organizer,
		attendees,
		selfResponse: attendees.find((attendee) => attendee.self)?.response,
		recurring: Boolean(raw.recurringEventId),
	};
}

export interface AccountRef {
	id: string;
	label: string;
}

export class GCalClient {
	/** `getAccount` is a getter because the label can be renamed while the client lives. */
	constructor(
		private readonly auth: GoogleAuth,
		private readonly getAccount: () => AccountRef
	) {}

	private async get(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
		const url = `${API_BASE}${path}?${new URLSearchParams(params).toString()}`;

		const send = async (token: string) =>
			requestUrl({
				url,
				method: "GET",
				headers: { Authorization: `Bearer ${token}` },
				throw: false,
			});

		let response = await send(await this.auth.getAccessToken());

		// A token can be revoked server-side before it expires; one retry covers that.
		if (response.status === 401) {
			response = await send(await this.auth.refresh());
		}

		if (response.status >= 400) {
			let detail = response.text;
			try {
				const body = response.json as { error?: { message?: string } };
				detail = body?.error?.message ?? detail;
			} catch {
				/* Keep the raw body. */
			}
			if (response.status === 403 && /calendar.*api.*disabled|has not been used/i.test(detail ?? "")) {
				throw new GCalError("The Google Calendar API is not enabled for this Cloud project. Enable it and retry.");
			}
			throw new GCalError(`Google Calendar API error ${response.status}: ${detail}`);
		}

		return (response.json ?? {}) as Record<string, unknown>;
	}

	async listCalendars(): Promise<CalendarInfo[]> {
		const account = this.getAccount();
		const calendars: CalendarInfo[] = [];
		let pageToken: string | undefined;
		let page = 0;

		do {
			const params: Record<string, string> = {
				minAccessRole: "reader",
				maxResults: String(PAGE_SIZE),
				showDeleted: "false",
			};
			if (pageToken) params.pageToken = pageToken;

			const body = await this.get("/users/me/calendarList", params);
			for (const raw of (body.items ?? []) as RawCalendarListEntry[]) {
				if (!raw.id || raw.deleted) continue;
				calendars.push({
					key: calendarKey(account.id, raw.id),
					id: raw.id,
					name: raw.summaryOverride ?? raw.summary ?? raw.id,
					color: raw.backgroundColor ?? "#7a86b8",
					primary: Boolean(raw.primary),
					timeZone: raw.timeZone,
					accountId: account.id,
					accountLabel: account.label,
				});
			}
			pageToken = body.nextPageToken as string | undefined;
		} while (pageToken && ++page < MAX_PAGES);

		return calendars.sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
	}

	/** The primary calendar's id is the account's email address, which we use as its stable id. */
	async fetchPrimaryAddress(): Promise<string | null> {
		const body = await this.get("/calendars/primary", {});
		return (body.id as string | undefined) ?? null;
	}

	async listEvents(query: EventQuery, calendar: CalendarInfo): Promise<CalEvent[]> {
		const events: CalEvent[] = [];
		let pageToken: string | undefined;
		let page = 0;

		do {
			const params: Record<string, string> = {
				singleEvents: "true",
				orderBy: "startTime",
				maxResults: String(PAGE_SIZE),
				timeMin: query.timeMin.toISOString(),
				timeMax: query.timeMax.toISOString(),
			};
			if (query.search) params.q = query.search;
			if (pageToken) params.pageToken = pageToken;

			const body = await this.get(`/calendars/${encodeURIComponent(query.calendarId)}/events`, params);
			for (const raw of (body.items ?? []) as RawEvent[]) {
				const event = normaliseEvent(raw, calendar);
				if (event) events.push(event);
			}
			pageToken = body.nextPageToken as string | undefined;
		} while (pageToken && ++page < MAX_PAGES);

		return events;
	}
}

export function describeError(error: unknown): string {
	if (error instanceof AuthError) return `Authentication: ${error.message}`;
	if (error instanceof GCalError) return error.message;
	if (error instanceof Error) return error.message;
	return String(error);
}
