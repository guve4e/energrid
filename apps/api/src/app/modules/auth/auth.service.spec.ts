import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

describe('AuthService', () => {
  const previousEnvironment = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...previousEnvironment,
      PORTAL_AUTH_EMAIL: 'guve4e@gmail.com',
      PORTAL_AUTH_PASSWORD: 'test-password',
      PORTAL_CONTROL_TOKEN: 'test-token',
    };
  });

  afterAll(() => {
    process.env = previousEnvironment;
  });

  it('accepts the configured account and returns its configured token', () => {
    const result = new AuthService().login({
      email: ' GUVE4E@gmail.com ',
      password: 'test-password',
    });

    expect(result).toEqual({
      accessToken: 'test-token',
      user: { id: '1', email: 'guve4e@gmail.com', name: 'Admin' },
    });
  });

  it('rejects a mismatched password', () => {
    expect(() =>
      new AuthService().login({
        email: 'guve4e@gmail.com',
        password: 'wrong-password',
      }),
    ).toThrow(UnauthorizedException);
  });
});
