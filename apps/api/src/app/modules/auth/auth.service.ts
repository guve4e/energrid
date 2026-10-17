import { Injectable, UnauthorizedException } from '@nestjs/common';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  login(dto: LoginDto) {
    const email = dto.email?.trim().toLowerCase();
    const password = dto.password ?? '';
    const expectedEmail =
      process.env.PORTAL_AUTH_EMAIL?.trim().toLowerCase() ||
      'admin@energrid.local';
    const expectedPassword = process.env.PORTAL_AUTH_PASSWORD || 'admin123';

    if (email !== expectedEmail || password !== expectedPassword) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return {
      accessToken: process.env.PORTAL_CONTROL_TOKEN || 'dev-token-admin',
      user: {
        id: '1',
        email: expectedEmail,
        name: 'Admin',
      },
    };
  }
}
