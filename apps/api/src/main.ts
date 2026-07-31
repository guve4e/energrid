import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { WsAdapter } from '@nestjs/platform-ws';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

function setupSwagger(app: Awaited<ReturnType<typeof NestFactory.create>>) {
  const config = new DocumentBuilder()
    .setTitle('Energrid API')
    .setDescription(
      [
        'REST API for Energrid development services.',
        '',
        'Voice WebSocket protocol:',
        '- connect to ws://<host>:<port>/voice',
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
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'warn', 'error'],
  });

  app.useWebSocketAdapter(new WsAdapter(app));

  app.enableCors({
    origin: [
      'http://localhost:5173',
      'http://127.0.0.1:5173',
      'http://localhost:4173',
      'http://localhost:4200',
      'http://127.0.0.1:4173',
    ],
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
    optionsSuccessStatus: 204,
  });

  setupSwagger(app);

  const port = process.env.PORT || 3000;
  await app.listen(port, '0.0.0.0');

  console.log(`Energrid API running on port ${port}`);
  console.log(`Energrid API docs available at http://localhost:${port}/api/docs`);
}

bootstrap();
