import { moment } from "obsidian";
import type { Moment, unitOfTime } from "moment";
import type { CalEvent } from "./types";

type MomentUnit = unitOfTime.DurationConstructor;

export type Edge = "start" | "end";

export interface Duration {
	value: number;
	unit: string;
}

/** Longest-first so `min` beats `m` and `mo` beats `m`. */
const UNIT_ALIASES: Array<[RegExp, string]> = [
	[/^(minutes?|mins?)$/, "minutes"],
	[/^(hours?|hrs?|h)$/, "hours"],
	[/^(days?|d)$/, "days"],
	[/^(weeks?|wks?|w)$/, "weeks"],
	[/^(months?|mo|m)$/, "months"],
	[/^(years?|yrs?|y)$/, "years"],
];

const UNIT_PATTERN =
	"minutes?|mins?|hours?|hrs?|h|days?|d|weeks?|wks?|w|months?|mo|m|years?|yrs?|y";

const OFFSET_RE = new RegExp(`([+-])\\s*(\\d+(?:\\.\\d+)?)\\s*(${UNIT_PATTERN})\\b`, "gi");
const DURATION_RE = new RegExp(`^(\\d+(?:\\.\\d+)?)\\s*(${UNIT_PATTERN})$`, "i");

function normaliseUnit(raw: string): string | null {
	const lower = raw.toLowerCase();
	for (const [pattern, unit] of UNIT_ALIASES) {
		if (pattern.test(lower)) return unit;
	}
	return null;
}

/** Parses `7d`, `2 weeks`, `90min`. Returns null when the text is not a duration. */
export function parseDuration(raw: string): Duration | null {
	const match = DURATION_RE.exec(raw.trim());
	if (!match) return null;
	const unit = normaliseUnit(match[2]);
	if (!unit) return null;
	return { value: Number(match[1]), unit };
}

interface Anchor {
	moment: Moment;
	/** Whether the anchor names a whole day, so it can be snapped to the start or end of it. */
	dayGranular: boolean;
}

function resolveAnchor(raw: string): Anchor | null {
	const text = raw.trim().toLowerCase();
	const now = moment();

	switch (text) {
		case "":
		case "today":
			return { moment: now.clone(), dayGranular: true };
		case "now":
			return { moment: now.clone(), dayGranular: false };
		case "tomorrow":
			return { moment: now.clone().add(1, "day"), dayGranular: true };
		case "yesterday":
			return { moment: now.clone().subtract(1, "day"), dayGranular: true };
		case "sow":
		case "start-of-week":
			return { moment: now.clone().startOf("week"), dayGranular: true };
		case "eow":
		case "end-of-week":
			return { moment: now.clone().endOf("week"), dayGranular: false };
		case "som":
		case "start-of-month":
			return { moment: now.clone().startOf("month"), dayGranular: true };
		case "eom":
		case "end-of-month":
			return { moment: now.clone().endOf("month"), dayGranular: false };
		case "soy":
		case "start-of-year":
			return { moment: now.clone().startOf("year"), dayGranular: true };
		case "eoy":
		case "end-of-year":
			return { moment: now.clone().endOf("year"), dayGranular: false };
	}

	const parsed = moment(
		raw.trim(),
		["YYYY-MM-DD", "YYYY-MM-DDTHH:mm", "YYYY-MM-DDTHH:mm:ss", "YYYY-MM-DD HH:mm"],
		true
	);
	if (!parsed.isValid()) return null;
	return { moment: parsed, dayGranular: raw.trim().length <= 10 };
}

/**
 * Resolves a date expression such as `today`, `sow+1w`, `2026-08-14`, `+3d`.
 * `edge` decides whether a whole-day anchor becomes 00:00 or 23:59:59.999,
 * which is what makes `to:` ranges inclusive of the named day.
 */
export function resolveDate(raw: string, edge: Edge): Moment | null {
	const text = String(raw).trim();
	if (!text) return null;

	const offsets: Array<{ sign: number; value: number; unit: string }> = [];
	OFFSET_RE.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = OFFSET_RE.exec(text)) !== null) {
		const unit = normaliseUnit(match[3]);
		if (!unit) return null;
		offsets.push({ sign: match[1] === "-" ? -1 : 1, value: Number(match[2]), unit });
	}

	const anchorText = text.replace(OFFSET_RE, "").trim();
	// A bare offset such as `+3d` is relative to today.
	const anchor = resolveAnchor(anchorText);
	if (!anchor) return null;

	let result = anchor.moment;
	for (const offset of offsets) {
		result = result.add(offset.sign * offset.value, offset.unit as MomentUnit);
	}

	// Offsets in sub-day units imply the caller means a precise instant.
	const subDay = offsets.some((o) => o.unit === "minutes" || o.unit === "hours");
	if (anchor.dayGranular && !subDay) {
		result = edge === "start" ? result.startOf("day") : result.endOf("day");
	}

	return result;
}

export function addDuration(base: Moment, duration: Duration): Moment {
	return base.clone().add(duration.value, duration.unit as MomentUnit);
}

/** `Today` / `Tomorrow` / `Yesterday`, falling back to the supplied format. */
export function dayHeading(day: Moment, format: string): string {
	const today = moment().startOf("day");
	const diff = day.clone().startOf("day").diff(today, "days");
	if (diff === 0) return "Today";
	if (diff === 1) return "Tomorrow";
	if (diff === -1) return "Yesterday";
	return day.format(format);
}

export function formatTime(value: Moment, use24Hour: boolean): string {
	return value.format(use24Hour ? "HH:mm" : "h:mma");
}

/** `09:30–10:00`, or `all day`. Shared by the renderer and the note templates. */
export function timeLabel(event: CalEvent, use24Hour: boolean): string {
	if (event.allDay) return "all day";
	const start = formatTime(event.start, use24Hour);
	if (event.end.isSame(event.start)) return start;
	return `${start}–${formatTime(event.end, use24Hour)}`;
}

/** `1h 30m`, `45m`, `2d`. */
export function formatDuration(start: Moment, end: Moment, allDay: boolean): string {
	if (allDay) {
		const days = Math.max(1, end.clone().endOf("day").diff(start.clone().startOf("day"), "days") + 1);
		return days === 1 ? "all day" : `${days}d`;
	}
	const totalMinutes = Math.max(0, end.diff(start, "minutes"));
	const hours = Math.floor(totalMinutes / 60);
	const minutes = totalMinutes % 60;
	if (hours === 0) return `${minutes}m`;
	if (minutes === 0) return `${hours}h`;
	return `${hours}h ${minutes}m`;
}
