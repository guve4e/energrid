import { Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  login(dto: LoginDto) {
    const email = dto.email?.trim().toLowerCase();
    const password = dto.password ?? '';
    const development = process.env.NODE_ENV !== 'production';
    const expectedEmail = process.env.PORTAL_ADMIN_EMAIL?.trim().toLowerCase() ||
      (development ? 'admin@energrid.local' : '');
    const expectedPassword = process.env.PORTAL_ADMIN_PASSWORD ||
      (development ? 'admin123' : '');
    const accessToken = process.env.PORTAL_CONTROL_TOKEN ||
      (development ? 'dev-token-admin' : '');

    if (!expectedEmail || !expectedPassword || !accessToken ||
        !constantTimeEqual(email || '', expectedEmail) ||
        !constantTimeEqual(password, expectedPassword)) {
      throw new UnauthorizedException('Invalid credentials');
    }

    return {
      accessToken,
      user: {
        id: '1',
        email: expectedEmail,
        name: process.env.PORTAL_ADMIN_NAME || 'Admin',
      },
    };
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest();
  const b = createHash('sha256').update(right).digest();
  return timingSafeEqual(a, b);
}
