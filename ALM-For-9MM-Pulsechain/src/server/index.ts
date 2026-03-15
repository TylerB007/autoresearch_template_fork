/**
 * Express API server for the ALM dashboard
 * Separate entry point from the bot (src/index.ts)
 */

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { loadConfig } from '../configLoader.js';
import { setupAllChains } from '../chain.js';
import { createAllContractRegistries } from '../contracts.js';
import { createMultiChainContext } from '../multiChain.js';
import logger from '../logger.js';

import authRouter, { requireAuth } from './auth.js';
import { createDashboardRouter } from './routes/dashboard.js';
import { createPositionsRouter } from './routes/positions.js';
import { createConfigRouter } from './routes/config.js';
import { createRebalancesRouter } from './routes/rebalances.js';
import { createAnalyticsRouter } from './routes/analytics.js';
import { createRecoveryRouter } from './routes/recovery.js';
import { createCalculatorRouter } from './routes/calculator.js';
import { createEventsRouter } from './routes/events.js';
import { createBotRouter } from './routes/bot.js';
import { createIntegrityRouter } from './routes/integrity.js';
import { initPriceService } from './services/priceService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ============================================================
// BOOTSTRAP
// ============================================================

const config = loadConfig();
const chainContexts = setupAllChains(config);
const registries = createAllContractRegistries(config, chainContexts);
const mctx = createMultiChainContext(config, chainContexts, registries);

// Default chain for backward-compatible routes
const chain = mctx.getChainById(mctx.defaultChainId);
const contracts = registries.get(mctx.defaultChainId)!.default;

// Initialize price service with default chain's DexScreener slug
initPriceService(config.chain.dexScreenerSlug);

for (const [chainId] of chainContexts) {
  const chainConfig = config.chains.get(chainId)!;
  const chainCtx = chainContexts.get(chainId)!;
  logger.info(`Dashboard server: ${chainConfig.chainName} (chain ${chainId}) initialized`, {
    wallet: chainCtx.wallet.address,
  });
}
logger.info(`Dashboard server: ${config.positions.length} position(s) across ${chainContexts.size} chain(s)`);

// ============================================================
// EXPRESS APP
// ============================================================

const app = express();

// Trust single-hop reverse proxy (Caddy) for correct client IP resolution
// Required for express-rate-limit to identify actual clients via X-Forwarded-For
app.set('trust proxy', 1);

// Security headers with Content Security Policy
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'], // Tailwind/inline styles + Google Fonts
      imgSrc: ["'self'", 'data:', 'https://assets.coingecko.com', 'https://raw.githubusercontent.com'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
}));

// CORS — restrict to dashboard origin (same-origin only)
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN ?? `http://localhost:${process.env.DASHBOARD_PORT ?? '3100'}`;
app.use(cors({ origin: DASHBOARD_ORIGIN }));

// JSON body parser
app.use(express.json());

// General rate limit: 100 requests per minute
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});
app.use('/api/', generalLimiter);

// Strict rate limit for login: 5 attempts per minute
const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later' },
});
app.use('/api/auth/login', loginLimiter);

// ============================================================
// ROUTES
// ============================================================

// Auth routes (unauthenticated)
app.use('/api/auth', authRouter);

// Protected API routes
app.use('/api/dashboard', requireAuth, createDashboardRouter(config, chain, contracts, mctx));
app.use('/api/positions', requireAuth, createPositionsRouter(config, chain, contracts, mctx));
app.use('/api/config', requireAuth, createConfigRouter(config));
app.use('/api/rebalances', requireAuth, createRebalancesRouter(config));
app.use('/api/analytics', requireAuth, createAnalyticsRouter(config, chain, contracts, mctx));
app.use('/api/recovery', requireAuth, createRecoveryRouter(config, chain, contracts, mctx));
app.use('/api/calculator', requireAuth, createCalculatorRouter(config, chain, contracts, mctx));
app.use('/api/events', requireAuth, createEventsRouter(config));
app.use('/api/bot', requireAuth, createBotRouter(config));
app.use('/api/integrity', requireAuth, createIntegrityRouter(config));

// ============================================================
// STATIC FILES & SPA FALLBACK
// ============================================================

const webDistPath = resolve(__dirname, '..', '..', 'src', 'web', 'dist');
if (existsSync(webDistPath)) {
  app.use(express.static(webDistPath));

  // SPA fallback: serve index.html for non-API routes
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ error: 'API route not found' });
      return;
    }
    res.sendFile(resolve(webDistPath, 'index.html'));
  });
} else {
  logger.warn(`Web dist directory not found at ${webDistPath} — static file serving disabled`);

  app.get('*', (req, res) => {
    if (req.path.startsWith('/api/')) {
      res.status(404).json({ error: 'API route not found' });
      return;
    }
    res.status(503).json({ error: 'Frontend not built. Run the web build first.' });
  });
}

// ============================================================
// START SERVER
// ============================================================

const PORT = parseInt(process.env.DASHBOARD_PORT ?? '3100', 10);
const HOST = process.env.DASHBOARD_HOST ?? '127.0.0.1';

app.listen(PORT, HOST, () => {
  logger.info(`Dashboard server listening on http://${HOST}:${PORT}`);
  logger.info(`Serving ${config.positions.length} position(s), dry_run=${config.dry_run}`);
});

export default app;
