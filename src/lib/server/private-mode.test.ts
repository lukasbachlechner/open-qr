import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '$lib/db';
import { canSignIn, isPrivateMode, isPublicPrivateModeRoute } from './private-mode';
import { createSession, hashSecret, resetOtpRateLimits, sendLoginCode, verifyOTP } from './auth';
import { handle } from '../../hooks.server';
import type { RequestEvent } from '@sveltejs/kit';

beforeEach(() => {
  vi.stubEnv('OPENQR_PRIVATE_MODE', 'true');
  vi.stubEnv('OPENQR_ALLOWED_EMAILS', ' Owner@Example.com , colleague@example.com ');
  resetOtpRateLimits();
  db.prepare('DELETE FROM otp_codes').run();
  db.prepare("DELETE FROM users WHERE email LIKE '%@example.com'").run();
});
afterEach(() => vi.unstubAllEnvs());

async function request(routeId: string, cookie?: string, method = 'GET') {
  const resolve = vi.fn(async () => new Response('protected content'));
  const event = {
    route: { id: routeId },
    url: new URL(routeId.replace('[short_code]', 'demo'), 'https://qr.example.com'),
    request: new Request('https://qr.example.com/', { method }),
    locals: { user: null },
    cookies: { get: () => cookie, delete: vi.fn() },
    getClientAddress: () => '192.0.2.5'
  } as unknown as RequestEvent;
  const response = await handle({ event, resolve });
  return { response, resolve };
}

describe('private deployment', () => {
  it('defaults to public mode and permits normal signup', async () => {
    vi.stubEnv('OPENQR_PRIVATE_MODE', '');
    expect(isPrivateMode()).toBe(false);
    expect(canSignIn('stranger@example.com')).toBe(true);
    const { response, resolve } = await request('/');
    expect(response.status).toBe(200);
    expect(resolve).toHaveBeenCalled();
  });

  it.each(['/', '/status', '/terms', '/report/[short_code]', '/dashboard', '/admin'])(
    'redirects anonymous visitors to %s', async (route) => {
      const { response, resolve } = await request(route);
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/login');
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(resolve).not.toHaveBeenCalled();
    }
  );

  it.each(['/api/v1/qr', '/api/v1/qr/demo/image', '/api/v1/status'])(
    'blocks anonymous API access to %s', async (route) => {
      const { response, resolve } = await request(route);
      expect(response.status).toBe(401);
      expect(resolve).not.toHaveBeenCalled();
    }
  );

  it('blocks anonymous QR creation even if the upstream anonymous flag is on', async () => {
    const { response } = await request('/api/v1/qr', undefined, 'POST');
    expect(response.status).toBe(401);
  });

  it.each(['/login', '/verify-otp', '/go/[short_code]', '/api/v1/auth/captcha', '/api/v1/health'])(
    'preserves essential public route %s', async (route) => {
      const { response, resolve } = await request(route);
      expect(response.status).toBe(200);
      expect(resolve).toHaveBeenCalled();
    }
  );

  it('preserves password-protected scan submissions and OTP endpoints', () => {
    expect(isPublicPrivateModeRoute('/go/[short_code]', 'POST')).toBe(true);
    expect(isPublicPrivateModeRoute('/api/v1/auth/otp/send', 'POST')).toBe(true);
    expect(isPublicPrivateModeRoute('/api/v1/auth/otp/verify', 'POST')).toBe(true);
    expect(isPublicPrivateModeRoute('/api/v1/auth/other', 'POST')).toBe(false);
    expect(isPublicPrivateModeRoute(null, 'GET')).toBe(true);
  });

  it('allows an existing user session to reach app pages', async () => {
    const row = db.prepare('INSERT INTO users (email) VALUES (?)').run('existing@example.com');
    const token = createSession(Number(row.lastInsertRowid));
    const { response, resolve } = await request('/', token);
    expect(response.status).toBe(200);
    expect(resolve).toHaveBeenCalled();
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(canSignIn('existing@example.com')).toBe(true);
  });

  it('normalizes the signup allowlist and fails closed when empty', () => {
    expect(canSignIn(' OWNER@example.COM ')).toBe(true);
    expect(canSignIn('stranger@example.com')).toBe(false);
    vi.stubEnv('OPENQR_ALLOWED_EMAILS', '');
    expect(canSignIn('owner@example.com')).toBe(false);
  });

  it('does not issue a code for an unapproved new account', async () => {
    await sendLoginCode('stranger@example.com');
    expect(db.prepare('SELECT id FROM otp_codes WHERE email = ?').get('stranger@example.com')).toBeUndefined();
  });

  it('rejects a previously issued valid code after enabling private mode', () => {
    db.prepare('INSERT INTO otp_codes (email, code, expires_at) VALUES (?, ?, ?)')
      .run('stranger@example.com', hashSecret('123456'), new Date(Date.now() + 60_000).toISOString());
    expect(verifyOTP('stranger@example.com', '123456').success).toBe(false);
    expect(db.prepare('SELECT id FROM users WHERE email = ?').get('stranger@example.com')).toBeUndefined();
  });

  it('allows a listed new user to finish OTP signup', () => {
    db.prepare('INSERT INTO otp_codes (email, code, expires_at) VALUES (?, ?, ?)')
      .run('owner@example.com', hashSecret('123456'), new Date(Date.now() + 60_000).toISOString());
    expect(verifyOTP('owner@example.com', '123456').success).toBe(true);
  });
});
