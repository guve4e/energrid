import { Body, Controller, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @ApiOperation({ summary: 'Log in to the Energrid portal' })
  @ApiOkResponse({
    description: 'Returns a configured access token and user profile.',
    schema: {
      example: {
        accessToken: '<configured portal token>',
        user: {
          id: '1',
          email: '<configured portal email>',
          name: 'Admin',
        },
      },
    },
  })
  @ApiUnauthorizedResponse({ description: 'Invalid credentials.' })
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }
}
