import type { Request, Response } from 'express';
import { z } from 'zod';
import type { AppConfig } from '../config.js';
import { defaultCountry, ERP_COUNTRIES, findCountry } from '../lib/countries.js';
import { normaliseCurrencyCode } from '../lib/currency.js';
import { AppError } from '../lib/errors.js';
import type { DailyRateJob } from '../services/dailyRateJob.js';
import type { EditorAuth, EditorSession } from '../services/editorAuth.js';
import type { EffectiveRateService } from '../services/effectiveRateService.js';
import type { RateSourceRegistry } from '../services/rateSources.js';

const SIMULATION_NOTICE =
  'Simulation only. Effective rates are held in the POC server memory and are NOT written to Zybo or any database.';
const BRANCH_NOTICE = 'Effective exchange rates apply to all branches under the selected country.';

const pairSchema = z.object({
  provider: z.string().trim().max(40).optional(),
  country: z.string().trim().regex(/^[A-Za-z]{2}$/, 'Expected a 2-letter country code'),
  currency: z.string().trim(),
});
const overrideSchema = pairSchema.extend({
  rate: z.union([z.string(), z.number()]),
  reason: z.string().trim().min(3, 'A reason is required').max(500),
});
const loginSchema = z.object({ passcode: z.string().min(1).max(200) });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) {
    throw new AppError(400, 'VALIDATION_ERROR', r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '));
  }
  return r.data;
}

const editorOf = (res: Response) => res.locals.editor as EditorSession & { token: string };

export function createErpController(deps: {
  effective: EffectiveRateService;
  sources: RateSourceRegistry;
  config: AppConfig;
  dailyJob: DailyRateJob;
  auth: EditorAuth;
}) {
  const { effective, sources, config, dailyJob, auth } = deps;
  const fallbackCountry = defaultCountry(config.targetCurrency);
  const providerOf = (v: unknown) => sources.get(typeof v === 'string' && v ? v : undefined);
  const pairOf = (body: z.infer<typeof pairSchema>) => ({
    providerId: providerOf(body.provider).id,
    countryCode: findCountry(body.country).code,
    currency: normaliseCurrencyCode(body.currency, 'currency'),
  });

  return {
    /** GET /api/erp-preview?provider=&country= – effective rates for one country plus per-country summary. */
    list(req: Request, res: Response) {
      const source = providerOf(req.query.provider);
      const country = typeof req.query.country === 'string' && req.query.country ? findCountry(req.query.country) : fallbackCountry;
      const all = effective.list(source.id);
      const session = auth.sessionFor(req);
      res.json({
        notice: SIMULATION_NOTICE,
        branchNotice: BRANCH_NOTICE,
        functionalCurrency: config.targetCurrency,
        erpCurrencies: config.erpCurrencies,
        maxDeviationPercent: config.maxDeviationPercent,
        providers: sources.describe(),
        provider: { id: source.id, label: source.label },
        countries: ERP_COUNTRIES,
        defaultCountry: fallbackCountry.code,
        editor: { configured: auth.configured, name: auth.editorName, signedIn: Boolean(session) },
        countrySummary: ERP_COUNTRIES.map((c) => {
          const rows = all.filter((r) => r.countryCode === c.code && config.erpCurrencies.includes(r.currencyCode));
          return {
            countryCode: c.code,
            total: rows.filter((r) => r.rate).length,
            overrides: rows.filter((r) => r.override).length,
            held: rows.filter((r) => r.held).length,
          };
        }),
        rates: all.filter((r) => r.countryCode === country.code && config.erpCurrencies.includes(r.currencyCode)),
      });
    },

    /** GET /api/erp-preview/history?provider=&country=&currency= */
    history(req: Request, res: Response) {
      const p = pairOf(parse(pairSchema, req.query));
      res.json({ ...p, history: effective.history(p.providerId, p.countryCode, p.currency) });
    },

    /** GET /api/erp-preview/audit?provider=&country= */
    audit(req: Request, res: Response) {
      const source = providerOf(req.query.provider);
      const country = typeof req.query.country === 'string' && req.query.country ? findCountry(req.query.country).code : undefined;
      res.json({ events: effective.auditLog({ providerId: source.id, countryCode: country, limit: 200 }) });
    },

    /** POST /api/erp-preview/rates/override – rate editor only. */
    override(req: Request, res: Response) {
      const body = parse(overrideSchema, req.body);
      const p = pairOf(body);
      const rate = effective.override(p.providerId, p.countryCode, p.currency, body.rate, body.reason, editorOf(res).name);
      res.json({ notice: SIMULATION_NOTICE, rate });
    },

    /** POST /api/erp-preview/rates/resume – rate editor only. */
    resume(req: Request, res: Response) {
      const p = pairOf(parse(pairSchema, req.body));
      res.json({ notice: SIMULATION_NOTICE, rate: effective.resumeAuto(p.providerId, p.countryCode, p.currency, editorOf(res).name) });
    },

    /** POST /api/erp-preview/rates/accept – rate editor only: accept an API rate that validation held back. */
    accept(req: Request, res: Response) {
      const p = pairOf(parse(pairSchema, req.body));
      res.json({ notice: SIMULATION_NOTICE, rate: effective.acceptHeld(p.providerId, p.countryCode, p.currency, editorOf(res).name) });
    },

    /** GET /api/erp-preview/sql?provider=&country= */
    sql(req: Request, res: Response) {
      const source = providerOf(req.query.provider);
      const country = typeof req.query.country === 'string' && req.query.country ? findCountry(req.query.country).code : undefined;
      res.type('text/plain').send(effective.buildSqlPreview(source.id, country));
    },

    /** DELETE /api/erp-preview – rate editor only. Clears the simulation and reloads fresh rates straight away. */
    async reset(_req: Request, res: Response) {
      effective.reset(editorOf(res).name);
      await dailyJob.run('manual');
      res.json({ notice: SIMULATION_NOTICE, ...dailyJob.getState() });
    },

    /** GET /api/erp-preview/schedule */
    schedule(_req: Request, res: Response) {
      res.json({ notice: SIMULATION_NOTICE, ...dailyJob.getState() });
    },

    /** POST /api/erp-preview/schedule/run – rate editor only. */
    async runSchedule(_req: Request, res: Response) {
      await dailyJob.run('manual');
      res.json({ notice: SIMULATION_NOTICE, ...dailyJob.getState() });
    },

    /** POST /api/auth/login { passcode } */
    login(req: Request, res: Response) {
      const { passcode } = parse(loginSchema, req.body);
      res.json(auth.login(passcode));
    },

    /** POST /api/auth/logout */
    logout(req: Request, res: Response) {
      const s = auth.sessionFor(req);
      auth.logout(s?.token ?? null);
      res.json({ ok: true });
    },

    /** GET /api/auth/me */
    me(req: Request, res: Response) {
      const s = auth.sessionFor(req);
      res.json({
        editorConfigured: auth.configured,
        editorName: auth.editorName,
        session: s ? { name: s.name, expiresAt: s.expiresAt } : null,
      });
    },
  };
}
