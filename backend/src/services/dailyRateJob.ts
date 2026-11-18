import type { AppConfig } from '../config.js';
import { ERP_COUNTRIES } from '../lib/countries.js';
import { AppError } from '../lib/errors.js';
import type { EffectiveRateService } from './effectiveRateService.js';
import { autoUpdateCountry } from './erpAutoUpdate.js';
import type { RateSourceRegistry } from './rateSources.js';

/**
 * AUTOMATIC RATE UPDATE (POC in-app scheduler).
 *
 * Every day at `DAILY_FETCH_TIME` (local time in `DAILY_FETCH_TIMEZONE`, default 08:00 Asia/Dubai) the job:
 *   1. fetches fresh rates from each configured provider (bypassing the cache),
 *   2. validates them and makes them the effective rates for every ERP country – no approval step,
 *   3. leaves manual overrides untouched. Nothing is written to Zybo (simulation only).
 * If a provider is down it retries every `DAILY_FETCH_RETRY_MINUTES`, up to `DAILY_FETCH_MAX_ATTEMPTS`.
 * If the server starts after the scheduled time and today's run hasn't happened, it runs straight away; if no
 * effective rates exist yet at startup, an initial load runs immediately.
 *
 * Limitation: it only runs while this server process is running. Production would use Windows Task Scheduler,
 * SQL Agent or a hosted scheduler calling the same logic.
 */

export type RunTrigger = 'schedule' | 'retry' | 'manual' | 'startup';
export type RunStatus = 'running' | 'success' | 'partial' | 'retrying' | 'failed';

export interface CountryRunResult {
  providerId: string;
  providerName: string;
  countryCode: string;
  countryName: string;
  baseCurrency: string;
  updated: number;
  unchanged: number;
  held: number;
  keptOverride: number;
  error: string | null;
}

export interface RunRecord {
  trigger: RunTrigger;
  startedAt: string;
  finishedAt: string | null;
  localDate: string;
  attempt: number;
  status: RunStatus;
  message: string;
  providers: { id: string; label: string; ok: boolean; effectiveDate: string | null; error: string | null }[];
  countries: CountryRunResult[];
}

export interface ScheduleState {
  enabled: boolean;
  time: string;
  timeZone: string;
  retryMinutes: number;
  maxAttempts: number;
  providers: { id: string; label: string }[];
  running: boolean;
  nextRunAt: string | null;
  lastRun: RunRecord | null;
}

/** Local calendar date and HH:MM of `d` in `timeZone`. */
export function zonedParts(d: Date, timeZone: string): { date: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** UTC instant of local `date` + `time` in `timeZone`. */
export function zonedToUtc(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const local = zonedParts(new Date(guess), timeZone);
  const [ly, lm, ld] = local.date.split('-').map(Number) as [number, number, number];
  const [lh, lmin] = local.time.split(':').map(Number) as [number, number];
  const offsetMs = Date.UTC(ly, lm - 1, ld, lh, lmin) - guess;
  return new Date(guess - offsetMs);
}

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export class DailyRateJob {
  private lastRun: RunRecord | null = null;
  /** Local date whose scheduled run is finished (successfully, partially, or out of retries). */
  private doneForDate: string | null = null;
  private attemptDate: string | null = null;
  private attempts = 0;
  private nextRetryAt: Date | null = null;
  private inflight: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly deps: { sources: RateSourceRegistry; effective: EffectiveRateService; config: AppConfig },
    private readonly now: () => Date = () => new Date(),
  ) {}

  private get settings() {
    return this.deps.config.dailyFetch;
  }

  /** Starts the schedule. Loads rates immediately if none exist yet, then checks every `intervalMs`. */
  start(intervalMs = 30_000): void {
    if (!this.settings.enabled || this.timer) return;
    void (async () => {
      if (this.deps.effective.isEmpty()) await this.run('startup');
      await this.tick();
    })();
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Runs the job if it is due. Safe to call often. */
  async tick(): Promise<void> {
    if (!this.settings.enabled || this.inflight) return;
    const now = this.now();
    const { date, time } = zonedParts(now, this.settings.timeZone);
    if (this.doneForDate === date) return;
    if (this.attemptDate === date && this.nextRetryAt) {
      if (now >= this.nextRetryAt) await this.run('retry');
      return;
    }
    if (time >= this.settings.time) await this.run('schedule');
  }

  /** Runs the update now. Manual and startup runs don't change the schedule's bookkeeping. */
  async run(trigger: RunTrigger): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.execute(trigger).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Providers the job covers (DAILY_FETCH_PROVIDERS), skipping unknown or unconfigured ones. */
  private jobSources() {
    const { sources } = this.deps;
    const wanted = this.settings.providers.filter((id) => sources.ids().includes(id)).map((id) => sources.get(id));
    const usable = wanted.filter((s) => s.configured);
    return usable.length ? usable : [sources.default];
  }

  private async execute(trigger: RunTrigger): Promise<void> {
    const { effective, config } = this.deps;
    const started = this.now();
    const { date } = zonedParts(started, this.settings.timeZone);
    const scheduled = trigger === 'schedule' || trigger === 'retry';
    if (scheduled && this.attemptDate !== date) {
      this.attemptDate = date;
      this.attempts = 0;
      this.nextRetryAt = null;
    }
    if (scheduled) this.attempts++;

    const record: RunRecord = {
      trigger,
      startedAt: started.toISOString(),
      finishedAt: null,
      localDate: date,
      attempt: scheduled ? this.attempts : 1,
      status: 'running',
      message: 'Fetching rates…',
      providers: [],
      countries: [],
    };
    this.lastRun = record;

    // Each provider is fetched and applied independently; one failing never blocks the other.
    for (const source of this.jobSources()) {
      const p = { id: source.id, label: source.label, ok: false, effectiveDate: null as string | null, error: null as string | null };
      record.providers.push(p);
      try {
        const snap = await source.rates.getSnapshot(config.targetCurrency, true);
        if (snap.allProvidersFailed) throw new AppError(502, 'UPSTREAM_UNAVAILABLE', snap.warnings.join(' '));
        p.effectiveDate = snap.snapshot.effectiveDate;
      } catch (e) {
        p.error = (e as Error).message;
        continue;
      }
      for (const country of ERP_COUNTRIES) {
        const base = { providerId: source.id, providerName: source.label, countryCode: country.code, countryName: country.name, baseCurrency: country.baseCurrency };
        try {
          const r = await autoUpdateCountry({ source, effective, config }, country);
          record.countries.push({
            ...base,
            updated: r.updated,
            unchanged: r.unchanged,
            held: r.held,
            keptOverride: r.keptOverride,
            error: r.staleSource ? r.messages[0] ?? 'Source data is stale.' : null,
          });
        } catch (e) {
          record.countries.push({ ...base, updated: 0, unchanged: 0, held: 0, keptOverride: 0, error: (e as Error).message });
        }
      }
      p.ok = record.countries.some((c) => c.providerId === source.id && !c.error);
      if (!p.ok && !p.error) p.error = record.countries.find((c) => c.providerId === source.id)?.error ?? 'No country could be updated.';
    }

    const finished = this.now();
    record.finishedAt = finished.toISOString();
    const failedProviders = record.providers.filter((p) => !p.ok);
    const fetchError =
      failedProviders.length === record.providers.length
        ? failedProviders.map((p) => `${p.label}: ${p.error}`).join(' ') || 'No rate provider is configured.'
        : null;

    if (fetchError) {
      if (scheduled && this.attempts < this.settings.maxAttempts) {
        this.nextRetryAt = new Date(finished.getTime() + this.settings.retryMinutes * 60_000);
        record.status = 'retrying';
        record.message = `Update failed (attempt ${this.attempts} of ${this.settings.maxAttempts}): ${fetchError} Current rates stay effective. Retrying in ${this.settings.retryMinutes} min.`;
      } else {
        if (scheduled) {
          this.doneForDate = date;
          this.nextRetryAt = null;
        }
        record.status = 'failed';
        record.message = scheduled
          ? `Update failed after ${this.attempts} attempts: ${fetchError} Current rates stay effective.`
          : `Update failed: ${fetchError} Current rates stay effective.`;
      }
      console.warn(`[auto-update] ${record.message}`);
      return;
    }

    if (scheduled) {
      this.doneForDate = date;
      this.nextRetryAt = null;
    }
    const sum = (k: 'updated' | 'held' | 'keptOverride') => record.countries.reduce((n, c) => n + c[k], 0);
    const failedCountries = record.countries.filter((c) => c.error);
    record.status = failedCountries.length || failedProviders.length ? 'partial' : 'success';
    const ok = record.providers.filter((p) => p.ok);
    const from = ok.map((p) => `${p.label} (rates of ${p.effectiveDate})`).join(' and ');
    record.message =
      (sum('updated') ? `${sum('updated')} rate(s) updated automatically from ${from}.` : `All rates already up to date with ${from}.`) +
      (sum('keptOverride') ? ` ${sum('keptOverride')} manual override(s) left unchanged.` : '') +
      (sum('held') ? ` ${sum('held')} rate(s) held: they moved more than ${config.maxDeviationPercent}% and need the rate editor.` : '') +
      (failedProviders.length ? ` Not updated: ${failedProviders.map((p) => `${p.label} – ${p.error}`).join('; ')}.` : '') +
      (failedCountries.length ? ` Countries not updated: ${failedCountries.map((c) => `${c.countryName} (${c.providerName})`).join(', ')}.` : '');
    console.log(`[auto-update] ${record.message}`);
  }

  getState(): ScheduleState {
    const s = this.settings;
    let nextRunAt: string | null = null;
    if (s.enabled) {
      const { date, time } = zonedParts(this.now(), s.timeZone);
      if (this.attemptDate === date && this.nextRetryAt && this.doneForDate !== date) {
        nextRunAt = this.nextRetryAt.toISOString();
      } else if (this.doneForDate === date) {
        nextRunAt = zonedToUtc(addDays(date, 1), s.time, s.timeZone).toISOString();
      } else if (time >= s.time) {
        nextRunAt = this.now().toISOString();
      } else {
        nextRunAt = zonedToUtc(date, s.time, s.timeZone).toISOString();
      }
    }
    return {
      enabled: s.enabled,
      time: s.time,
      timeZone: s.timeZone,
      retryMinutes: s.retryMinutes,
      maxAttempts: s.maxAttempts,
      providers: this.jobSources().map((x) => ({ id: x.id, label: x.label })),
      running: this.inflight !== null,
      nextRunAt,
      lastRun: this.lastRun,
    };
  }
}
