import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/passwords.js';
import { issueToken, verifyToken } from '../src/auth/jwt.js';
import type { Config } from '../src/config.js';

const mockConfig = { jwtSecret: 'test-secret-key-for-testing', jwtExpiresIn: '1h' } as Config;

describe('passwords', () => {
  it('hashes and verifies', async () => {
    const hash = await hashPassword('mypassword123');
    expect(hash).not.toBe('mypassword123');
    expect(await verifyPassword('mypassword123', hash)).toBe(true);
  });
  it('rejects wrong password', async () => {
    const hash = await hashPassword('correct');
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });
});

describe('jwt', () => {
  it('issues and verifies a token', async () => {
    const token = await issueToken({ sub: '1', username: 'alice', role: 'admin' }, mockConfig);
    expect(token.split('.')).toHaveLength(3);
    const payload = await verifyToken(token, mockConfig);
    expect(payload.sub).toBe('1');
    expect(payload.username).toBe('alice');
    expect(payload.role).toBe('admin');
  });
  it('rejects tampered token', async () => {
    const token = await issueToken({ sub: '1', username: 'alice', role: 'admin' }, mockConfig);
    await expect(verifyToken(token.slice(0, -5) + 'xxxxx', mockConfig)).rejects.toThrow();
  });
  it('rejects wrong secret', async () => {
    const token = await issueToken({ sub: '1', username: 'alice', role: 'admin' }, mockConfig);
    await expect(verifyToken(token, { ...mockConfig, jwtSecret: 'other' } as Config)).rejects.toThrow();
  });
});
