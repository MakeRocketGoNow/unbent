import { afterEach, describe, expect, it, vi } from 'vitest';
import { forgetSession, rememberSession, rememberedSession } from './session-memory.js';

describe('session memory', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('remembers only what the chrome and the cache need', () => {
    rememberSession({ id: 'u1', email: 'someone@example.com', name: 'Someone' });
    expect(rememberedSession()).toEqual({ user: { id: 'u1', email: 'someone@example.com', name: 'Someone' } });
    expect(JSON.parse(localStorage.getItem('unbent.session')!)).toEqual({
      user: { id: 'u1', email: 'someone@example.com', name: 'Someone' },
    });
  });

  it('leaves out a missing name rather than storing null', () => {
    rememberSession({ id: 'u1', email: 'someone@example.com', name: null });
    expect(rememberedSession()).toEqual({ user: { id: 'u1', email: 'someone@example.com' } });
  });

  it('forgets', () => {
    rememberSession({ id: 'u1', email: 'someone@example.com' });
    forgetSession();
    expect(rememberedSession()).toBeNull();
  });

  it.each([
    ['not JSON', '{'],
    ['no user', '{}'],
    ['no id', '{"user":{"email":"someone@example.com"}}'],
  ])('treats a stored value that is %s as nobody', (_, raw) => {
    localStorage.setItem('unbent.session', raw);
    expect(rememberedSession()).toBeNull();
  });

  it('survives storage that refuses', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => rememberSession({ id: 'u1', email: 'someone@example.com' })).not.toThrow();
    expect(rememberedSession()).toBeNull();
  });
});
