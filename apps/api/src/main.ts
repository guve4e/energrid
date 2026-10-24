import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { WsAdapter } from '@nestjs/platform-ws';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { apiListenHost } from './server-listen-config';
import { config as loadDotenv } from 'dotenv';
import { resolve } from 'node:path';
import { AuthConfig } from './app/modules/auth/auth-config';
import helmet from 'helmet';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

function setupSwagger(app: Awaited<ReturnType<typeof NestFactory.create>>) {
  const config = new DocumentBuilder()
    .setTitle('Energrid API')
    .setDescription(
      [
        'REST API for Energrid development services.',
        '',
        'Voice WebSocket protocol:',
        '- connect to ws://<host>:<port>/voice',
        '- send { "type": "authenticate", "token": "<15-minute access JWT>" } first',
        '- send 16kHz mono PCM16 binary audio chunks',
        '- send { "type": "end_of_turn" } after VAD detects silence',
        '- receive JSON events: session_start, stt_partial, stt_final, assistant_text_delta, assistant_audio_chunk, assistant_final, turn_end, error',
        '',
        'Use pnpm voice:replay /path/to/test.wav to replay a 16kHz mono PCM16 WAV into the voice socket.',
      ].join('\n'),
    )
    .setVersion('0.1.0')
    .addTag('auth', 'Development authentication endpoints')
    .addTag('panel', 'Panel compilation and diagnostics')
    .addTag('voice', 'WebSocket voice protocol documentation')
    .build();

  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup('api/docs', app, document, {
    jsonDocumentUrl: 'api/docs-json',
    swaggerOptions: {
      persistAuthorization: true,
      displayRequestDuration: true,
    },
  });
}

async function bootstrap() {
  if (process.env.NODE_ENV !== 'production') {
    loadDotenv({ path: resolve(process.cwd(), '.env.auth.local'), override: true, quiet: true });
  }
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  app.use(helmet({ contentSecurityPolicy: false }));
  app.getHttpAdapter().getInstance().disable('x-powered-by');

  app.useWebSocketAdapter(new WsAdapter(app));

  const authConfig = app.get(AuthConfig);
  app.enableCors({
    origin: Array.from(authConfig.value.trustedOrigins),
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
    credentials: true,
    optionsSuccessStatus: 204,
  });

  setupSwagger(app);

  const port = process.env.PORT || 3000;
  const host = apiListenHost();
  await app.listen(port, host);
  const httpServer = app.getHttpServer();
  const upgradeListeners = httpServer.listeners('upgrade');
  httpServer.removeAllListeners('upgrade');
  httpServer.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    let pathname = '';
    try { pathname = new URL(request.url || '/', 'http://localhost').pathname; } catch { socket.destroy(); return; }
    if (pathname === '/portal/device-proxy' || pathname.startsWith('/portal/device-proxy/')) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }

    for (const listener of upgradeListeners) {
      listener.call(httpServer, request, socket, head);
    }
  });

  console.log(`Energrid API running on port ${port}`);
  console.log(`Energrid API docs available at http://${host}:${port}/api/docs`);
}

bootstrap();
