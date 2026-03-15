/**
 * Authentication — JWT-based login and route protection middleware
 *
 * DASHBOARD_PASSWORD supports two formats:
 *   - Bcrypt hash (starts with "$2a$" or "$2b$") — recommended, constant-time comparison
 *   - Plaintext string — legacy fallback, will log a warning on startup
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import logger from '../logger.js';

const JWT_ISSUER = '9mm-rebalancer-dashboard';
const JWT_AUDIENCE = '9mm-rebalancer';

const router = Router();

function getJwtSecret(): string {
  const secret = process.env.DASHBOARD_JWT_SECRET;
  if (!secret) {
    throw new Error('DASHBOARD_JWT_SECRET not set in environment');
  }
  return secret;
}

function getDashboardPassword(): string {
  const password = process.env.DASHBOARD_PASSWORD;
  if (!password) {
    throw new Error('DASHBOARD_PASSWORD not set in environment');
  }
  return password;
}

/** Check if the stored password is a bcrypt hash */
function isBcryptHash(value: string): boolean {
  return /^\$2[aby]\$\d{2}\$.{53}$/.test(value);
}

// Deferred password check — runs on first login request, not at import time.
// This module is imported before dotenv.config() runs, so process.env is empty
// at import time. The old top-level getDashboardPassword() call crashed the server.
let passwordWarningEmitted = false;
function emitPasswordWarning(): void {
  if (passwordWarningEmitted) return;
  passwordWarningEmitted = true;
  try {
    const pw = getDashboardPassword();
    if (!isBcryptHash(pw)) {
      logger.warn(
        'DASHBOARD_PASSWORD is stored in plaintext. Generate a bcrypt hash with: node -e "import(\'bcryptjs\').then(b=>b.hash(process.argv[1],10).then(console.log))" YOUR_PASSWORD',
      );
    }
  } catch {
    // Will throw again at request time with a clear error
  }
}

// POST /api/auth/login
router.post('/login', async (req: Request, res: Response) => {
  try {
    emitPasswordWarning();

    const { password } = req.body as { password?: string };

    if (!password) {
      res.status(400).json({ error: 'Password is required' });
      return;
    }

    const expected = getDashboardPassword();

    let isValid: boolean;
    if (isBcryptHash(expected)) {
      // Constant-time bcrypt comparison
      isValid = await bcrypt.compare(password, expected);
    } else {
      // Legacy plaintext — use timingSafeEqual to avoid timing attacks
      const a = Buffer.from(password);
      const b = Buffer.from(expected);
      isValid = a.length === b.length && timingSafeEqual(a, b);
    }

    if (!isValid) {
      logger.warn('Dashboard login attempt with incorrect password');
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    const token = jwt.sign({ role: 'admin' }, getJwtSecret(), {
      expiresIn: '24h',
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });

    logger.info('Dashboard login successful');
    res.json({ token, expiresIn: 86400 });
  } catch (err) {
    logger.error('Login error', { error: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Middleware: validate Bearer token on protected routes
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const secret = getJwtSecret();
    jwt.verify(token, secret, {
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    next();
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      res.status(401).json({ error: 'Token expired' });
      return;
    }
    res.status(401).json({ error: 'Invalid token' });
  }
}

export default router;
