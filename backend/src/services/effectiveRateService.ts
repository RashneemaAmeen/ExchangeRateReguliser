import { randomUUID } from 'node:crypto';
import type { ErpCountry } from '../lib/countries.js';
import { Decimal, parsePositiveDecimal, toFixedString } from '../lib/decimal.js';
import { AppError } from '../lib/errors.js';
import type { NormalisedRate } from './rateMath.js';
import type { StalenessResult } from './staleness.js';

/**
 * EFFECTIVE ERP RATES – simulation of Zybo's Branches Exchange Rate table (in memory, nothing is written to Zybo).
 *
 * Normal flow is fully automatic: each scheduled update validates the provider's rates and makes them effective.
 * There is no approval step. The one designated rate editor can override an individual rate; an override is
 * never touched by later automatic updates until the editor chooses "Resume Auto Update".
 *
 * One effective rate per provider + country + currency. Every change is appended to that rate's history and to
 * the audit log; previous values are never edited.
 *
 * Rate direction: units of the country's base currency per 1 unit of the foreign currency (1 USD = 3.6725 AED).
 */

export type RateType = 'AUTOMATIC' | 'MANUAL_OVERRIDE';
export type HistoryKind = 'AUTO_UPDATE' | 'MANUAL_OVERRIDE' | 'OVERRIDE_REMOVED' | 'API_RATE_ACCEPTED';
export type AuditAction =
  | 'RATE_UPDATED'
  | 'UPDATE_HELD'
  | 'MANUAL_OVERRIDE'
  | 'OVERRIDE_REMOVED'
  | 'API_RATE_ACCEPTED'
  | 'SIMULATION_RESET';

export const AUTO_USER = 'Automatic update';

export interface HistoryEntry {
  id: string;
  at: string;
  kind: HistoryKind;
  rate: string;
  previousRate: string | null;
  effectiveDate: string;
  user: string;
  reason: string | null;
  deviationPercent: string | null;
  source: string;
}

export interface AuditEvent {
  id: string;
  at: string;
  user: string;
  action: AuditAction;
  providerId: string;
  countryCode: string | null;
  currencyCode: string | null;
  previousRate: string | null;
  newRate: string | null;
  reason: string | null;
  detail: string | null;
}

export interface EffectiveRate {
  providerId: string;
  providerName: string;
  countryCode: string;
  countryName: string;
  baseCurrency: string;
  currencyCode: string;
  currencyName: string;
  /** Rate type of the provider's rate, e.g. "Reference (mid-market)" or "Daily average midpoint (OANDA)". */
  rateLabel: string;
  /** The rate Zybo would use now (override if one is active, otherwise the last automatic rate). Null until first set. */
  rate: string | null;
  rateType: RateType;
  effectiveDate: string | null;
  source: string;
  updatedAt: string | null;
  updatedBy: string | null;
  /** Last rate applied automatically (kept while an override is active, so resuming is instant). */
  autoRate: string | null;
  autoEffectiveDate: string | null;
  /** Latest rate seen from the provider, even when it was not applied. */
  latestApi: { rate: string; effectiveDate: string; retrievedAt: string; deviationPercent: string | null } | null;
  override: { rate: string; previousRate: string | null; reason: string; by: string; at: string } | null;
  /** Set when the latest automatic update failed validation; the previous rate stays effective. */
  held: { apiRate: string; effectiveDate: string; deviationPercent: string | null; reason: string; at: string } | null;
  /** % change of the effective rate at its last update vs the rate before (null for a first rate). */
  changePercent: string | null;
  warnings: string[];
  historyCount: number;
}

export interface AutoUpdateInput {
  provider: { id: string; label: string };
  country: ErpCountry;
  rates: NormalisedRate[];
  effectiveDate: string;
  retrievedAt: string;
  staleness: StalenessResult;
  source: string;
  rateLabel?: string;
  /** Provider's previous-day rates – baseline for the deviation check when a pair has no automatic rate yet. */
  previousDay?: { effectiveDate: string; rates: Record<string, string> } | null;
}

export interface AutoUpdateResult {
  updated: number;
  unchanged: number;
  held: number;
  keptOverride: number;
  staleSource: boolean;
  messages: string[];
}

interface Entry {
  rate: EffectiveRate;
  history: HistoryEntry[];
}

const keyOf = (providerId: string, countryCode: string, currency: string) => `${providerId}|${countryCode}|${currency}`;

export class EffectiveRateService {
  private readonly entries = new Map<string, Entry>();
  private readonly audit: AuditEvent[] = [];

  constructor(
    private readonly options: { rateDecimalPlaces: number; maxDeviationPercent: number },
    private readonly now: () => Date = () => new Date(),
    private readonly newId: () => string = () => randomUUID(),
  ) {}

  /* ------------------------------------------------------------------ reads */

  list(providerId: string, countryCode?: string): EffectiveRate[] {
    return [...this.entries.values()]
      .map((e) => e.rate)
      .filter((r) => r.providerId === providerId && (!countryCode || r.countryCode === countryCode))
      .sort((a, b) => a.countryCode.localeCompare(b.countryCode) || a.currencyCode.localeCompare(b.currencyCode));
  }

  isEmpty(): boolean {
    return this.entries.size === 0;
  }

  get(providerId: string, countryCode: string, currency: string): EffectiveRate {
    return this.entry(providerId, countryCode, currency).rate;
  }

  history(providerId: string, countryCode: string, currency: string): HistoryEntry[] {
    return [...this.entry(providerId, countryCode, currency).history];
  }

  auditLog(filter: { providerId?: string; countryCode?: string; limit?: number } = {}): AuditEvent[] {
    return this.audit
      // Events for all providers/countries (e.g. a simulation reset) are shown in every filtered view.
      .filter(
        (a) =>
          (!filter.providerId || a.providerId === filter.providerId || a.providerId === '*') &&
          (!filter.countryCode || a.countryCode === filter.countryCode || a.countryCode === null),
      )
      .slice(-(filter.limit ?? 200))
      .reverse();
  }

  /** Whether any pair in this country has no automatic baseline yet (then previous-day rates are worth fetching). */
  needsBaseline(providerId: string, countryCode: string, currencies: string[]): boolean {
    return currencies.some((c) => !this.entries.get(keyOf(providerId, countryCode, c))?.rate.autoRate);
  }

  private entry(providerId: string, countryCode: string, currency: string): Entry {
    const e = this.entries.get(keyOf(providerId, countryCode, currency));
    if (!e) {
      throw new AppError(404, 'NOT_FOUND', `No ${currency} rate exists yet for ${countryCode} from this provider. Run the automatic update first.`);
    }
    return e;
  }

  private log(e: Omit<AuditEvent, 'id' | 'at'>): void {
    this.audit.push({ id: this.newId(), at: this.now().toISOString(), ...e });
    if (this.audit.length > 5000) this.audit.splice(0, this.audit.length - 5000);
  }

  private push(entry: Entry, h: Omit<HistoryEntry, 'id' | 'at'>): void {
    entry.history.unshift({ id: this.newId(), at: this.now().toISOString(), ...h });
    if (entry.history.length > 200) entry.history.length = 200;
    entry.rate.historyCount = entry.history.length;
  }

  private pct(value: Decimal, baseline: string | null): Decimal | null {
    if (!baseline) return null;
    const b = new Decimal(baseline);
    return value.minus(b).div(b).mul(100);
  }

  private fmtPct(d: Decimal | null): string | null {
    return d ? d.toFixed(2).replace(/^-(0\.0+)$/, '$1') : null;
  }

  /* ---------------------------------------------------------- automatic update */

  applyAutoUpdate(input: AutoUpdateInput): AutoUpdateResult {
    const result: AutoUpdateResult = { updated: 0, unchanged: 0, held: 0, keptOverride: 0, staleSource: false, messages: [] };
    const { provider, country } = input;
    const at = this.now().toISOString();

    if (input.staleness.status === 'stale') {
      result.staleSource = true;
      result.messages.push(`Source data is stale (${input.staleness.message}); current rates were kept.`);
      return result;
    }

    for (const r of input.rates) {
      if (r.currencyCode === country.baseCurrency) continue;
      const value = new Decimal(r.rate);
      if (!value.isFinite() || value.lte(0)) {
        result.messages.push(`${r.currencyCode}: invalid rate from provider; current rate kept.`);
        continue;
      }
      const rateStr = toFixedString(value, this.options.rateDecimalPlaces);
      const k = keyOf(provider.id, country.code, r.currencyCode);
      let e = this.entries.get(k);
      if (!e) {
        e = {
          history: [],
          rate: {
            providerId: provider.id,
            providerName: provider.label,
            countryCode: country.code,
            countryName: country.name,
            baseCurrency: country.baseCurrency,
            currencyCode: r.currencyCode,
            currencyName: r.currencyName,
            rateLabel: input.rateLabel ?? 'Reference (mid-market)',
            rate: null,
            rateType: 'AUTOMATIC',
            effectiveDate: null,
            source: input.source,
            updatedAt: null,
            updatedBy: null,
            autoRate: null,
            autoEffectiveDate: null,
            latestApi: null,
            override: null,
            held: null,
            changePercent: null,
            warnings: [],
            historyCount: 0,
          },
        };
        this.entries.set(k, e);
      }
      const rec = e.rate;
      const baseline = rec.autoRate ?? input.previousDay?.rates[r.currencyCode] ?? null;
      const dev = this.pct(value, baseline);
      rec.latestApi = { rate: rateStr, effectiveDate: input.effectiveDate, retrievedAt: input.retrievedAt, deviationPercent: this.fmtPct(dev) };

      // 1. A manual override always wins; the API rate is only recorded for reference.
      if (rec.override) {
        result.keptOverride++;
        continue;
      }
      // 2. Nothing new.
      if (rec.autoRate && new Decimal(rec.autoRate).eq(value) && rec.autoEffectiveDate === input.effectiveDate) {
        result.unchanged++;
        continue;
      }
      // 3. Validation: a large move against the previous rate for this same pair is held, not applied.
      if (dev && dev.abs().gt(this.options.maxDeviationPercent)) {
        const reason =
          `Moved ${dev.abs().toFixed(2)}% vs ${rec.autoRate ? 'the current rate' : 'the previous day'} ${baseline} ` +
          `(limit ${this.options.maxDeviationPercent}%). ${rec.rate ? 'The current rate stays effective' : 'No rate is effective yet'} until the rate editor accepts or edits it.`;
        const isNew = !rec.held || rec.held.apiRate !== rateStr || rec.held.effectiveDate !== input.effectiveDate;
        rec.held = { apiRate: rateStr, effectiveDate: input.effectiveDate, deviationPercent: this.fmtPct(dev), reason, at };
        result.held++;
        if (isNew) {
          this.log({
            user: AUTO_USER,
            action: 'UPDATE_HELD',
            providerId: provider.id,
            countryCode: country.code,
            currencyCode: r.currencyCode,
            previousRate: rec.rate,
            newRate: rateStr,
            reason: null,
            detail: reason,
          });
        }
        continue;
      }
      // 4. Apply.
      const previous = rec.rate;
      rec.rate = rateStr;
      rec.rateLabel = input.rateLabel ?? rec.rateLabel;
      rec.autoRate = rateStr;
      rec.autoEffectiveDate = input.effectiveDate;
      rec.rateType = 'AUTOMATIC';
      rec.effectiveDate = input.effectiveDate;
      rec.source = input.source;
      rec.updatedAt = at;
      rec.updatedBy = AUTO_USER;
      rec.held = null;
      rec.changePercent = this.fmtPct(dev);
      rec.warnings = baseline ? [] : ['First rate for this pair: there was no previous rate to check the deviation limit against.'];
      this.push(e, {
        kind: 'AUTO_UPDATE',
        rate: rateStr,
        previousRate: previous,
        effectiveDate: input.effectiveDate,
        user: AUTO_USER,
        reason: null,
        deviationPercent: this.fmtPct(dev),
        source: input.source,
      });
      this.log({
        user: AUTO_USER,
        action: 'RATE_UPDATED',
        providerId: provider.id,
        countryCode: country.code,
        currencyCode: r.currencyCode,
        previousRate: previous,
        newRate: rateStr,
        reason: null,
        detail: `Effective ${input.effectiveDate} from ${input.source}`,
      });
      result.updated++;
    }
    return result;
  }

  /* ---------------------------------------------------- rate editor actions */

  override(providerId: string, countryCode: string, currency: string, rawRate: unknown, reason: string, user: string): EffectiveRate {
    const e = this.entry(providerId, countryCode, currency);
    const value = parsePositiveDecimal(rawRate);
    if (!value) throw new AppError(400, 'VALIDATION_ERROR', 'The rate must be a positive decimal number, for example 3.6725.');
    const why = reason.trim();
    if (why.length < 3) throw new AppError(400, 'VALIDATION_ERROR', 'A reason is required for a manual rate.');
    const rec = e.rate;
    const rateStr = toFixedString(value, this.options.rateDecimalPlaces);
    const at = this.now().toISOString();
    const previous = rec.rate;
    const effectiveDate = at.slice(0, 10);
    rec.override = { rate: rateStr, previousRate: previous, reason: why, by: user, at };
    rec.rate = rateStr;
    rec.rateType = 'MANUAL_OVERRIDE';
    rec.effectiveDate = effectiveDate;
    rec.updatedAt = at;
    rec.updatedBy = user;
    rec.held = null;
    rec.warnings = [];
    rec.changePercent = this.fmtPct(this.pct(new Decimal(rateStr), previous));
    this.push(e, {
      kind: 'MANUAL_OVERRIDE',
      rate: rateStr,
      previousRate: previous,
      effectiveDate,
      user,
      reason: why,
      deviationPercent: this.fmtPct(this.pct(new Decimal(rateStr), previous)),
      source: `Manual override by ${user}`,
    });
    this.log({ user, action: 'MANUAL_OVERRIDE', providerId, countryCode, currencyCode: currency, previousRate: previous, newRate: rateStr, reason: why, detail: null });
    return rec;
  }

  /** Removes the override. The latest API rate becomes effective if it passes validation; otherwise the last automatic rate does. */
  resumeAuto(providerId: string, countryCode: string, currency: string, user: string): EffectiveRate {
    const e = this.entry(providerId, countryCode, currency);
    const rec = e.rate;
    if (!rec.override) throw new AppError(409, 'INVALID_STATE', `${currency} is already updated automatically.`);
    const at = this.now().toISOString();
    const previous = rec.rate;
    rec.override = null;
    rec.rateType = 'AUTOMATIC';

    const api = rec.latestApi;
    const apiDev = api?.deviationPercent ? new Decimal(api.deviationPercent).abs() : null;
    const apiOk = api && (!apiDev || apiDev.lte(this.options.maxDeviationPercent) || !rec.autoRate);
    if (api && apiOk) {
      rec.autoRate = api.rate;
      rec.autoEffectiveDate = api.effectiveDate;
    } else if (api) {
      rec.held = {
        apiRate: api.rate,
        effectiveDate: api.effectiveDate,
        deviationPercent: api.deviationPercent,
        reason: `Latest API rate moved ${apiDev?.toFixed(2)}% vs the last automatic rate; the last automatic rate is used until it is accepted.`,
        at,
      };
    }
    rec.changePercent = rec.autoRate && previous ? this.fmtPct(this.pct(new Decimal(rec.autoRate), previous)) : null;
    rec.rate = rec.autoRate;
    rec.effectiveDate = rec.autoEffectiveDate;
    rec.updatedAt = at;
    rec.updatedBy = user;
    this.push(e, {
      kind: 'OVERRIDE_REMOVED',
      rate: rec.rate ?? '',
      previousRate: previous,
      effectiveDate: rec.effectiveDate ?? at.slice(0, 10),
      user,
      reason: null,
      deviationPercent: null,
      source: 'Automatic updates resumed',
    });
    this.log({ user, action: 'OVERRIDE_REMOVED', providerId, countryCode, currencyCode: currency, previousRate: previous, newRate: rec.rate, reason: null, detail: 'Automatic updates resumed' });
    return rec;
  }

  /** Accepts an API rate that automatic validation held back (e.g. a genuine move above the deviation limit). */
  acceptHeld(providerId: string, countryCode: string, currency: string, user: string): EffectiveRate {
    const e = this.entry(providerId, countryCode, currency);
    const rec = e.rate;
    if (!rec.held) throw new AppError(409, 'INVALID_STATE', `There is no held rate for ${currency}.`);
    if (rec.override) throw new AppError(409, 'INVALID_STATE', `${currency} has a manual override. Resume automatic updates first.`);
    const at = this.now().toISOString();
    const previous = rec.rate;
    const h = rec.held;
    rec.rate = h.apiRate;
    rec.autoRate = h.apiRate;
    rec.autoEffectiveDate = h.effectiveDate;
    rec.effectiveDate = h.effectiveDate;
    rec.rateType = 'AUTOMATIC';
    rec.updatedAt = at;
    rec.updatedBy = user;
    rec.held = null;
    rec.warnings = [];
    rec.changePercent = h.deviationPercent;
    this.push(e, {
      kind: 'API_RATE_ACCEPTED',
      rate: h.apiRate,
      previousRate: previous,
      effectiveDate: h.effectiveDate,
      user,
      reason: null,
      deviationPercent: h.deviationPercent,
      source: `${rec.source} (accepted by ${user})`,
    });
    this.log({ user, action: 'API_RATE_ACCEPTED', providerId, countryCode, currencyCode: currency, previousRate: previous, newRate: h.apiRate, reason: null, detail: h.reason });
    return rec;
  }

  reset(user: string): void {
    this.entries.clear();
    this.log({ user, action: 'SIMULATION_RESET', providerId: '*', countryCode: null, currencyCode: null, previousRate: null, newRate: null, reason: null, detail: 'All simulated effective rates cleared' });
  }

  /* ---------------------------------------------------------------- SQL */

  /** Generates (never executes) the T-SQL a future integration would run for the current effective rates. */
  buildSqlPreview(providerId: string, countryCode?: string): string {
    const rows = this.list(providerId, countryCode).filter((r) => r.rate);
    const q = (s: string | null) => (s === null ? 'NULL' : `N'${s.replace(/'/g, "''")}'`);
    const ts = (s: string | null) => (s ? `'${s.replace('T', ' ').slice(0, 19)}'` : 'NULL');
    const dp = this.options.rateDecimalPlaces;
    const lines = [
      '-- ============================================================================',
      '-- PREVIEW ONLY – generated by the Exchange Rate POC. NOT EXECUTED.',
      '-- No connection to Zybo or SQL Server exists in this POC.',
      `-- Generated ${this.now().toISOString()} · provider ${providerId}${countryCode ? ` · country ${countryCode}` : ''}`,
      '-- ExchangeRate = units of BaseCurrency per 1 unit of CurrencyCode. Country-level: applies to all branches.',
      '-- Append-only: a change inserts a new row; earlier rows (rates already used) are never updated.',
      '-- ============================================================================',
      '',
      'CREATE TABLE dbo.ExchangeRateEffective (',
      '    ExchangeRateEffectiveId BIGINT IDENTITY(1,1) PRIMARY KEY,',
      '    RateProvider     VARCHAR(40)    NOT NULL,',
      '    CountryCode      CHAR(2)        NOT NULL,',
      '    BaseCurrency     CHAR(3)        NOT NULL,',
      '    CurrencyCode     CHAR(3)        NOT NULL,',
      `    ExchangeRate     DECIMAL(19,${dp})  NOT NULL CHECK (ExchangeRate > 0),`,
      '    EffectiveDate    DATE           NOT NULL,',
      "    RateType         VARCHAR(20)    NOT NULL,  -- 'AUTOMATIC' or 'MANUAL_OVERRIDE'",
      `    PreviousRate     DECIMAL(19,${dp})  NULL,`,
      '    OverrideReason   NVARCHAR(500)  NULL,',
      '    Source           NVARCHAR(200)  NOT NULL,',
      '    UpdatedBy        NVARCHAR(100)  NOT NULL,',
      '    UpdatedAt        DATETIME2(0)   NOT NULL',
      ');',
      '',
    ];
    if (!rows.length) {
      lines.push('-- No effective rates yet.');
      return lines.join('\n');
    }
    lines.push(
      'INSERT INTO dbo.ExchangeRateEffective',
      '    (RateProvider, CountryCode, BaseCurrency, CurrencyCode, ExchangeRate, EffectiveDate, RateType, PreviousRate,',
      '     OverrideReason, Source, UpdatedBy, UpdatedAt)',
      'VALUES',
    );
    rows.forEach((r, i) => {
      const v = [
        `'${r.providerId}'`,
        `'${r.countryCode}'`,
        `'${r.baseCurrency}'`,
        `'${r.currencyCode}'`,
        r.rate,
        `'${r.effectiveDate}'`,
        `'${r.rateType}'`,
        r.override?.previousRate ?? 'NULL',
        q(r.override?.reason ?? null),
        q(r.source.slice(0, 200)),
        q(r.updatedBy ?? AUTO_USER),
        ts(r.updatedAt),
      ];
      lines.push(`    (${v.join(', ')})${i === rows.length - 1 ? ';' : ','}`);
    });
    return lines.join('\n');
  }
}
