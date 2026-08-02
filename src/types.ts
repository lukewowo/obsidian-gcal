import type { Moment } from "moment";

export type ViewMode = "agenda" | "list" | "table";

export type GroupMode = "date" | "calendar" | "account" | "none";

export type AllDayMode = "include" | "exclude" | "only";

/** Fields that can be surfaced in agenda/list views and used as table columns. */
export type Field =
	| "date"
	| "day"
	| "time"
	| "start"
	| "end"
	| "duration"
	| "title"
	| "calendar"
	| "account"
	| "location"
	| "description"
	| "attendees"
	| "organizer"
	| "status"
	| "response"
	| "link"
	| "note";

export interface CalendarInfo {
	/** `accountId::calendarId` — unique even when two accounts subscribe to the same calendar. */
	key: string;
	id: string;
	name: string;
	color: string;
	primary: boolean;
	timeZone?: string;
	accountId: string;
	accountLabel: string;
}

export interface Attendee {
	email?: string;
	name?: string;
	/** accepted | declined | tentative | needsAction */
	response?: string;
	self: boolean;
	optional: boolean;
	resource: boolean;
}

export interface CalEvent {
	id: string;
	calendarKey: string;
	calendarId: string;
	calendarName: string;
	calendarColor: string;
	accountId: string;
	accountLabel: string;
	title: string;
	start: Moment;
	/** Inclusive end. For all-day events Google's exclusive end date is already adjusted. */
	end: Moment;
	allDay: boolean;
	location?: string;
	description?: string;
	link?: string;
	meetUrl?: string;
	/** confirmed | tentative | cancelled */
	status?: string;
	organizer?: string;
	attendees: Attendee[];
	/** This account's own response, when it is an attendee. */
	selfResponse?: string;
	recurring: boolean;
}
