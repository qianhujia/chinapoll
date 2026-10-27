// How long a deadline poll still has to run, phrased for the badge that sits beside
// its title on the poll list and the poll page.
//
// The label is worked out when the page is rendered and never ticked: a visitor
// reads the time that was left at the moment the page loaded, which is why the
// helper takes `nowMs` instead of reading the clock itself. The server-rendered
// first paint and the client paint call it with their own clock, so both show the
// same wording.
//
// The unit and the number travel apart so the caller can fill the number into the
// matching translation. Each unit has a singular and a plural key (English needs
// both: `1 day left` and `13 days left`); the Chinese translations read the same
// either way.

export interface TimeLeft {
  /** The i18n key naming the unit, already singular or plural. */
  key: string;
  /** The whole number of that unit still to run; 0 for the marker keys. */
  value: number;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// The largest whole unit left before the end date, or the "ended" marker once it
// has passed. Returns null when the poll carries no usable end date, so the caller
// can fall back to the plain mode label.
export function timeLeftUntil(endAt: string | null | undefined, nowMs: number): TimeLeft | null {
  if (!endAt) return null;
  const end = Date.parse(endAt);
  if (!Number.isFinite(end)) return null;

  const remaining = end - nowMs;
  if (remaining <= 0) return { key: 'timeLeftEnded', value: 0 };

  const days = Math.floor(remaining / DAY_MS);
  if (days >= 1) return { key: days === 1 ? 'timeLeftDay' : 'timeLeftDays', value: days };

  const hours = Math.floor(remaining / HOUR_MS);
  if (hours >= 1) return { key: hours === 1 ? 'timeLeftHour' : 'timeLeftHours', value: hours };

  const minutes = Math.floor(remaining / MINUTE_MS);
  if (minutes >= 1) return { key: minutes === 1 ? 'timeLeftMinute' : 'timeLeftMinutes', value: minutes };

  // Under a minute: naming a number would be wrong more often than right.
  return { key: 'timeLeftUnderMinute', value: 0 };
}

// The badge text for a deadline poll: the time it has left, or the poll's plain
// mode label when there is no end date to count down to. `t` is the locale lookup,
// so the client and the server share one phrasing.
export function deadlineBadgeLabel(
  endAt: string | null | undefined,
  nowMs: number,
  t: (key: string) => string
): string {
  const left = timeLeftUntil(endAt, nowMs);
  if (!left) return t('deadline');
  return t(left.key).replace('{n}', String(left.value));
}
