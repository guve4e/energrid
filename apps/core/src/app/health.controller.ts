import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({ summary: 'Check core service health' })
  @ApiOkResponse({
    schema: {
      example: {
        status: 'ok',
        service: 'core',
      },
    },
  })
  getHealth() {
    return {
      status: 'ok',
      service: 'core',
    };
  }
}
