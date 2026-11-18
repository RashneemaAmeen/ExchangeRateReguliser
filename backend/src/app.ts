import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AppConfig } from './config.js';
import { createErpController } from './controllers/erpController.js';
import { createExchangeRateController } from './controllers/exchangeRateController.js';
import { isAppError } from './lib/errors.js';
import type { ExchangeRateProvider } from './providers/types.js';
import { DailyRateJob } from './services/dailyRateJob.js';
import { EditorAuth } from './services/editorAuth.js';
import { EffectiveRateService } from './services/effectiveRateService.js';
import { createRateSources } from './services/rateSources.js';
import { createOandaProvider, createProvider } from './providers/index.js';
import type { OandaRateType } from './providers/oandaProvider.js';

export interface AppDeps {
  config: AppConfig;
  /** Provider chain for the existing ExchangeRate-API integration (primary, then fallback). */
  providers: ExchangeRateProvider[];
  /** Provider chain for currencyapi.com. Defaults to the real adapter built from config (tests inject fakes). */
  currencyApiComProviders?: ExchangeRateProvider[];
  /** OANDA chain. A function builds one per rate type (default: real adapters); a fixed array is used for every type (tests). */
  oandaProviders?: ExchangeRateProvider[] | ((rateType: OandaRateType) => ExchangeRateProvider[]);
  now?: () => Date;
}

/** Builds the Express app. Dependencies are injected so tests can use fake providers. */
export function createApp({ config, providers, currencyApiComProviders, oandaProviders, now }: AppDeps) {
  const sources = createRateSources(
    config,
    {
      exchangeRateApi: providers,
      currencyApiCom: currencyApiComProviders ?? [createProvider('currencyapi-com', config)],
      oanda: oandaProviders ?? ((t) => [createOandaProvider(config, t)]),
    },
    now,
  );
  const effective = new EffectiveRateService(
    { rateDecimalPlaces: config.rateDecimalPlaces, maxDeviationPercent: config.maxDeviationPercent },
    now,
  );
  const auth = new EditorAuth(config.erpEditor, now);
  const dailyJob = new DailyRateJob({ sources, effective, config }, now);
  const rates = createExchangeRateController(sources, config);
  const erp = createErpController({ effective, sources, config, dailyJob, auth });
  const editorOnly = auth.requireEditor;

  const app = express();
  app.disable('x-powered-by');
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: '50kb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, time: (now ?? (() => new Date()))().toISOString() });
  });

  // Named routes must come before /:currency.
  app.get('/api/providers', rates.providers);
  app.get('/api/exchange-rates', rates.list);
  app.get('/api/exchange-rates/compare', rates.compare);
  app.get('/api/exchange-rates/status', rates.status);
  app.get('/api/exchange-rates/currencies', rates.currencies);
  app.get('/api/exchange-rates/convert', rates.convert);
  app.get('/api/exchange-rates/history', rates.history);
  app.get('/api/exchange-rates/:currency', rates.single);

  app.post('/api/auth/login', erp.login);
  app.post('/api/auth/logout', erp.logout);
  app.get('/api/auth/me', erp.me);

  // Read-only for everyone.
  app.get('/api/erp-preview', erp.list);
  app.get('/api/erp-preview/history', erp.history);
  app.get('/api/erp-preview/audit', erp.audit);
  app.get('/api/erp-preview/sql', erp.sql);
  app.get('/api/erp-preview/schedule', erp.schedule);
  // Rate editor only – enforced here on the server, not just by hiding buttons.
  app.post('/api/erp-preview/rates/override', editorOnly, erp.override);
  app.post('/api/erp-preview/rates/resume', editorOnly, erp.resume);
  app.post('/api/erp-preview/rates/accept', editorOnly, erp.accept);
  app.post('/api/erp-preview/schedule/run', editorOnly, erp.runSchedule);
  app.delete('/api/erp-preview', editorOnly, erp.reset);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown API endpoint.' } });
  });

  // Central error handler – Express 5 forwards rejected promises here automatically.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (isAppError(err)) {
      res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details } });
      return;
    }
    if ((err as { type?: string })?.type === 'entity.parse.failed') {
      res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Request body is not valid JSON.' } });
      return;
    }
    console.error('[unhandled]', err);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error.' } });
  });

  // The scheduler is started by server.ts, not here, so tests never get background timers.
  app.locals.dailyJob = dailyJob;
  return app;
}
