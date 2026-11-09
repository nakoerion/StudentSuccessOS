/**
 * Quiet hours are stored as minutes of the day (0–1439) in the TENANT's IANA time zone
 * (`tenant.timezone`). start > end wraps midnight (21:00–07:00); start = end means none.
 * The window is [start, end): a message at exactly `end` is delivered.
 */
export interface QuietHours {
  startMinute: number;
  endMinute: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    // Throws RangeError for an unknown zone — a misconfigured tenant must not silently use UTC.
    f = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Local wall-clock minute of the day (0–1439) of `at` in `timeZone`. */
export function minuteOfDayIn(at: Date, timeZone: string): number {
  const parts = formatter(timeZone).formatToParts(at);
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  const minute = Number(parts.find((p) => p.type === "minute")?.value);
  return hour * 60 + minute;
}

export function isQuietAt(at: Date, quiet: QuietHours | null | undefined, timeZone: string): boolean {
  if (!quiet || quiet.startMinute === quiet.endMinute) return false;
  const m = minuteOfDayIn(at, timeZone);
  return quiet.startMinute < quiet.endMinute
    ? m >= quiet.startMinute && m < quiet.endMinute
    : m >= quiet.startMinute || m < quiet.endMinute;
}

/**
 * The first instant at or after `at` that is outside quiet hours (`at` itself if it
 * already is). Lands on the local `end` minute, correcting for a DST shift in between.
 */
export function quietHoursEndAfter(at: Date, quiet: QuietHours | null | undefined, timeZone: string): Date {
  if (!quiet || !isQuietAt(at, quiet, timeZone)) return at;
  const startOfMinute = at.getTime() - (at.getTime() % 60_000);
  const minutesAhead = (quiet.endMinute - minuteOfDayIn(at, timeZone) + 1440) % 1440;
  let candidate = new Date(startOfMinute + minutesAhead * 60_000);
  // A DST change inside the window moves wall-clock time by up to an hour either way.
  const drift = quiet.endMinute - minuteOfDayIn(candidate, timeZone);
  if (drift !== 0 && Math.abs(drift) <= 120) candidate = new Date(candidate.getTime() + drift * 60_000);
  return candidate;
}

export interface DeliveryTimingInput {
  now: Date;
  timeZone: string;
  quiet: QuietHours | null | undefined;
  /** A critical alert. */
  critical?: boolean;
  /** notification_preference.critical_bypasses_quiet (default true). */
  criticalBypassesQuiet?: boolean;
}

/** When an outbox row may be sent: now, or the end of the recipient's quiet hours. */
export function deliveryTime(input: DeliveryTimingInput): { at: Date; deferred: boolean } {
  if (input.critical && input.criticalBypassesQuiet !== false) return { at: input.now, deferred: false };
  const at = quietHoursEndAfter(input.now, input.quiet, input.timeZone);
  return { at, deferred: at.getTime() !== input.now.getTime() };
}
