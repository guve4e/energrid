import 'reflect-metadata';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app/app.module';

dotenv.config({
  path: path.resolve(process.cwd(), '.env'),
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('core');
  app.enableCors();

  const swaggerConfig = new DocumentBuilder()
    .setTitle('Energrid Core API')
    .setDescription(
      [
        'Core REST API for estimates, installation passports, weather intelligence, and river telemetry.',
        '',
        'All routes in this app are served under the /core prefix.',
      ].join('\n'),
    )
    .setVersion('0.1.0')
    .addTag('health', 'Core service health')
    .addTag('estimator', 'Estimate preview, assistant step, persistence, and catalog')
    .addTag('installations', 'Installation passports, panels, circuits, and service entries')
    .addTag('weather', 'Weather dashboard and monitoring endpoints')
    .addTag('river', 'Danube river collection, history, context, and forecast performance')
    .build();

  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('core/docs', app, swaggerDocument, {
    jsonDocumentUrl: 'core/docs-json',
    swaggerOptions: {
      displayRequestDuration: true,
    },
  });

  const port = Number(process.env.CORE_PORT || 3020);
  await app.listen(port);

  console.log(`[core] listening on http://localhost:${port}/core`);
  console.log(`[core] docs available at http://localhost:${port}/core/docs`);
}

bootstrap();
