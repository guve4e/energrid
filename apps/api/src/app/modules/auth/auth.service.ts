import { Injectable, UnauthorizedException } from '@nestjs/common';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  login(dto: LoginDto) {
    const email = dto.email?.trim().toLowerCase();
    const password = dto.password ?? '';

    if (email !== 'admin@energrid.local' || password !== 'admin123') {
      throw new UnauthorizedException('Invalid credentials');
    }

    return {
      accessToken: 'dev-token-admin',
      user: {
        id: '1',
        email: 'admin@energrid.local',
        name: 'Admin',
      },
    };
  }
}
