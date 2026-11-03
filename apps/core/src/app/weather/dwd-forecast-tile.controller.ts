import { BadRequestException, Controller, Get, Param, ParseIntPipe, Query, Req, Res } from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { DwdForecastTileService } from './dwd-forecast-tile.service';
import { PALETTE_VERSION } from './precipitation-tile-renderer';

interface RawImageResponse {
  setHeader(name: string, value: string): void;
  status(code: number): RawImageResponse;
  send(body: Buffer | string): RawImageResponse;
}

interface ClientRequest {
  socket?: { remoteAddress?: string };
}

function clientId(request: ClientRequest) {
  return request.socket?.remoteAddress || 'unknown';
}

@ApiTags('weather')
@Controller('weather/radar-forecast')
export class DwdForecastTileController {
  constructor(private readonly tiles: DwdForecastTileService) {}

  @Get('capabilities')
  @ApiProduces('application/xml')
  @ApiOperation({ summary: 'Get the published DWD ICON-EU run and valid-time dimensions' })
  async getCapabilities(@Req() request: ClientRequest, @Res() response: RawImageResponse) {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    const xml = await this.tiles.capabilities(clientId(request));
    response.setHeader('Content-Type', 'application/xml; charset=utf-8');
    response.status(200).send(xml);
  }

  @Get(':run/:valid/:z/:x/:y.png')
  @ApiProduces('image/png')
  @ApiOperation({ summary: 'Render a cached DWD ICON-EU hourly precipitation tile' })
  async getTile(
    @Param('run') run: string,
    @Param('valid') valid: string,
    @Param('z', ParseIntPipe) z: number,
    @Param('x', ParseIntPipe) x: number,
    @Param('y', ParseIntPipe) y: number,
    @Query('palette') palette: string,
    @Req() request: ClientRequest,
    @Res() response: RawImageResponse,
  ) {
    // If Nest turns a thrown upstream/client error into JSON, do not let an
    // intermediary retain that failure under an immutable tile URL.
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (palette !== PALETTE_VERSION) throw new RangeError('Unsupported forecast tile palette version');
      const image = await this.tiles.tile(run, valid, z, x, y, clientId(request));
      response.setHeader('Content-Type', 'image/png');
      response.setHeader('Cache-Control', 'public, max-age=86400, immutable');
      response.setHeader('X-Forecast-Run', run);
      response.setHeader('X-Forecast-Valid-Time', valid);
      response.status(200).send(image);
    } catch (error) {
      if (error instanceof RangeError) throw new BadRequestException(error.message);
      throw error;
    }
  }
}
