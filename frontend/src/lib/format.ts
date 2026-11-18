/**
 * Display helpers. Rates arrive from the backend as exact decimal strings and are
 * never converted to JS numbers for arithmetic – only formatted for display.
 */

/** Add thousands separators to a decimal string without converting to Number. */
export function groupDigits(value: string): string {
  const [int = '', frac] = value.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac !== undefined ? `${grouped}.${frac}` : grouped;
}

const dateTimeFmt = new Intl.DateTimeFormat('en-GB', {
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  timeZone: 'Asia/Dubai',
  timeZoneName: 'short',
});

const dateFmt = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: '2-digit',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

/** Timestamps are shown in UAE time (Asia/Dubai) for finance users. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return dateTimeFmt.format(new Date(iso));
}

/** Effective dates are calendar dates (no time zone shift). */
export function formatDate(isoDate: string | null | undefined): string {
  if (!isoDate) return '—';
  return dateFmt.format(new Date(`${isoDate}T00:00:00Z`));
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.round((now - new Date(iso).getTime()) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

export function cx(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}
