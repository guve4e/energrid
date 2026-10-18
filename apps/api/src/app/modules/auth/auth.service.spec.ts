import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('uses configured credentials and token', () => {
    process.env = {
      ...originalEnv,
      NODE_ENV: 'production',
      PORTAL_ADMIN_EMAIL: 'Operator@Example.com',
      PORTAL_ADMIN_PASSWORD: 'strong-secret',
      PORTAL_CONTROL_TOKEN: 'signed-in-token',
      PORTAL_ADMIN_NAME: 'Operator',
    };

    expect(new AuthService().login({ email: 'operator@example.com', password: 'strong-secret' })).toEqual({
      accessToken: 'signed-in-token',
      user: { id: '1', email: 'operator@example.com', name: 'Operator' },
    });
  });

  it('fails closed when production credentials are missing', () => {
    process.env = { ...originalEnv, NODE_ENV: 'production' };
    expect(() => new AuthService().login({ email: 'admin@energrid.local', password: 'admin123' }))
      .toThrow(UnauthorizedException);
  });

  it('keeps the development login available outside production', () => {
    process.env = { ...originalEnv, NODE_ENV: 'test' };
    expect(new AuthService().login({ email: ' ADMIN@ENERGRID.LOCAL ', password: 'admin123' }).accessToken)
      .toBe('dev-token-admin');
  });
});
