/**
 * Decide whether a set of published rates is fresh, legitimately delayed by a
 * weekend/holiday, or stale (business days have been missed).
 * Pure function – all inputs explicit so it is easy to test.
 */

export type StalenessStatus = 'fresh' | 'delayed' | 'stale';

export interface StalenessInput {
  effectiveDate: string; // YYYY-MM-DD
  publishedAt: string | null; // ISO
  now: Date;
  staleAfterHours: number;
  weekendDays: number[]; // 0=Sun..6=Sat
  holidays: string[]; // YYYY-MM-DD
}

export interface StalenessResult {
  status: StalenessStatus;
  ageHours: number;
  /** Days after the effective date (up to yesterday) that had no publication and were expected to. */
  missingBusinessDays: string[];
  /** Days after the effective date (up to yesterday) that are weekends/holidays. */
  nonPublishingDays: string[];
  message: string;
}

const DAY_MS = 86_400_000;
const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function utcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00Z`);
}
function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function evaluateStaleness(input: StalenessInput): StalenessResult {
  const { effectiveDate, publishedAt, now, staleAfterHours, weekendDays, holidays } = input;
  const holidaySet = new Set(holidays);
  const reference = publishedAt ? new Date(publishedAt) : utcDate(effectiveDate);
  const ageHours = Math.max(0, Math.round(((now.getTime() - reference.getTime()) / 3_600_000) * 10) / 10);

  const today = utcDate(isoDay(now));
  const missingBusinessDays: string[] = [];
  const nonPublishingDays: string[] = [];
  // Walk every day strictly after the effective date and strictly before today.
  // (Today's rates may legitimately not be published yet.)
  for (let t = utcDate(effectiveDate).getTime() + DAY_MS; t < today.getTime(); t += DAY_MS) {
    const d = new Date(t);
    const iso = isoDay(d);
    if (weekendDays.includes(d.getUTCDay()) || holidaySet.has(iso)) nonPublishingDays.push(iso);
    else missingBusinessDays.push(iso);
  }

  const label = (iso: string) => `${WEEKDAY[utcDate(iso).getUTCDay()]} ${iso}`;

  if (missingBusinessDays.length > 0) {
    return {
      status: 'stale',
      ageHours,
      missingBusinessDays,
      nonPublishingDays,
      message: `Rates are dated ${label(effectiveDate)}. No rates were received for ${missingBusinessDays.length} business day(s) (${missingBusinessDays.join(', ')}). Verify before use.`,
    };
  }
  if (nonPublishingDays.length > 0) {
    return {
      status: 'delayed',
      ageHours,
      missingBusinessDays,
      nonPublishingDays,
      message: `Rates are dated ${label(effectiveDate)}. The gap covers weekend/holiday day(s) (${nonPublishingDays
        .map(label)
        .join(', ')}) on which reference rates are usually not published. This is expected.`,
    };
  }
  if (ageHours > staleAfterHours) {
    return {
      status: 'stale',
      ageHours,
      missingBusinessDays,
      nonPublishingDays,
      message: `Rates were published ${ageHours} hours ago, exceeding the ${staleAfterHours}-hour freshness threshold.`,
    };
  }
  return {
    status: 'fresh',
    ageHours,
    missingBusinessDays,
    nonPublishingDays,
    message: `Rates are dated ${label(effectiveDate)} – the most recent publication expected from this provider.`,
  };
}
