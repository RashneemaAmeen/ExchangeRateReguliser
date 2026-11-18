import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors.js';

/**
 * ONE designated rate editor (POC stand-in for real sign-in such as Entra ID).
 *
 * The editor's name and passcode live only in backend/.env (ERP_EDITOR_NAME, ERP_EDITOR_PASSCODE).
 * Signing in returns a random session token held in server memory; every edit endpoint checks it.
 * Hiding buttons in the browser is only a convenience – the backend refuses edits without a valid session.
 * If no passcode is configured, nobody can edit.
 */
export interface EditorSession {
  name: string;
  expiresAt: string;
}

const SESSION_HOURS = 8;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 5 * 60_000;

const digest = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export class EditorAuth {
  private readonly sessions = new Map<string, { name: string; expires: number }>();
  private failures: number[] = [];

  constructor(
    private readonly editor: { name: string; passcode: string | null },
    private readonly now: () => Date = () => new Date(),
  ) {}

  get configured(): boolean {
    return Boolean(this.editor.passcode);
  }

  get editorName(): string {
    return this.editor.name;
  }

  login(passcode: unknown): { token: string } & EditorSession {
    if (!this.editor.passcode) {
      throw new AppError(403, 'FORBIDDEN', 'Rate editing is turned off: no editor passcode is set (ERP_EDITOR_PASSCODE in backend/.env).');
    }
    const t = this.now().getTime();
    this.failures = this.failures.filter((f) => t - f < LOCKOUT_MS);
    if (this.failures.length >= MAX_FAILURES) {
      throw new AppError(429, 'TOO_MANY_ATTEMPTS', 'Too many wrong passcodes. Try again in a few minutes.');
    }
    const ok = typeof passcode === 'string' && timingSafeEqual(digest(passcode), digest(this.editor.passcode));
    if (!ok) {
      this.failures.push(t);
      throw new AppError(401, 'UNAUTHORIZED', 'Wrong passcode.');
    }
    const token = randomBytes(32).toString('hex');
    const expires = t + SESSION_HOURS * 3_600_000;
    this.sessions.set(token, { name: this.editor.name, expires });
    return { token, name: this.editor.name, expiresAt: new Date(expires).toISOString() };
  }

  logout(token: string | null): void {
    if (token) this.sessions.delete(token);
  }

  /** The signed-in editor for this request, or null for a normal (read-only) user. */
  sessionFor(req: Request): (EditorSession & { token: string }) | null {
    const token = tokenOf(req);
    if (!token) return null;
    const s = this.sessions.get(token);
    if (!s) return null;
    if (s.expires <= this.now().getTime()) {
      this.sessions.delete(token);
      return null;
    }
    return { token, name: s.name, expiresAt: new Date(s.expires).toISOString() };
  }

  /** Express middleware: only the designated editor may continue. Sets res.locals.editor. */
  requireEditor = (req: Request, res: Response, next: NextFunction): void => {
    const s = this.sessionFor(req);
    if (!s) {
      next(
        new AppError(
          403,
          'FORBIDDEN',
          this.configured
            ? `Only the rate editor (${this.editor.name}) can do this. Sign in as the rate editor first.`
            : 'Rate editing is turned off: no editor passcode is set (ERP_EDITOR_PASSCODE in backend/.env).',
        ),
      );
      return;
    }
    res.locals.editor = s;
    next();
  };
}

export function tokenOf(req: Request): string | null {
  const h = req.headers.authorization;
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7).trim() || null;
  return null;
}
