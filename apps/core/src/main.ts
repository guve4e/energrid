import 'reflect-metadata';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';

dotenv.config({
  path: path.resolve(process.cwd(), '.env'),
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('core');
  app.enableCors();

  const port = Number(process.env.CORE_PORT || 3020);
  await app.listen(port);

  console.log(`[core] listening on http://localhost:${port}/core`);
}

bootstrap();
