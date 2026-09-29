import { db } from '$lib/db';

/** Deployment policy, deliberately not editable through the public settings API. */
export function isPrivateMode(): boolean {
  return process.env.OPENQR_PRIVATE_MODE === 'true';
}

export function canSignIn(email: string): boolean {
  if (!isPrivateMode()) return true;
  const normalized = email.trim().toLowerCase();
  const allowed = (process.env.OPENQR_ALLOWED_EMAILS || '')
    .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (allowed.includes(normalized)) return true;
  return Boolean(db.prepare('SELECT id FROM users WHERE email = ?').get(normalized));
}

/** Use SvelteKit route IDs so data requests receive the same protection. */
export function isPublicPrivateModeRoute(routeId: string | null, method: string): boolean {
  // Static assets and unmatched routes have no application route ID.
  if (routeId === null) return true;
  if (routeId === '/go/[short_code]') return true;
  if (method === 'GET' || method === 'HEAD') {
    return ['/login', '/verify-otp', '/api/v1/auth/captcha', '/api/v1/health'].includes(routeId);
  }
  return method === 'POST' &&
    ['/api/v1/auth/otp/send', '/api/v1/auth/otp/verify'].includes(routeId);
}
