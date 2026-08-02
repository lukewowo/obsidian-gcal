/**
 * Obsidian re-exports moment as `typeof import("moment")`, so its types come from
 * the moment package. Where those are not resolvable — which is the case in the
 * plugin review's lint environment — the whole thing degrades to `any`, and every
 * date expression in this plugin gets reported as an unsafe call or access.
 *
 * Declaring the surface we actually use keeps the code typed there. It costs
 * nothing at runtime, and tsc checks the declarations against real usage here, so
 * the shape cannot silently drift from what moment provides.
 */
import { moment as obsidianMoment } from "obsidian";

export type MomentUnit =
	| "second"
	| "seconds"
	| "minute"
	| "minutes"
	| "hour"
	| "hours"
	| "day"
	| "days"
	| "week"
	| "weeks"
	| "month"
	| "months"
	| "year"
	| "years";

export interface Moment {
	clone(): Moment;
	add(amount: number, unit: MomentUnit): Moment;
	subtract(amount: number, unit: MomentUnit): Moment;
	startOf(unit: MomentUnit): Moment;
	endOf(unit: MomentUnit): Moment;
	format(format?: string): string;
	diff(other: Moment, unit: MomentUnit): number;
	isValid(): boolean;
	isSame(other: Moment): boolean;
	isSameOrBefore(other: Moment): boolean;
	valueOf(): number;
	toISOString(): string;
	fromNow(): string;
}

export interface MomentFactory {
	(): Moment;
	(input?: string): Moment;
	(input: string | undefined, format: string | string[], strict?: boolean): Moment;
}

export const moment = obsidianMoment as unknown as MomentFactory;
