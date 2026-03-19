import { NestFactory } from '@nestjs/core'
import { AppModule } from './app/app.module'
import { WsAdapter } from '@nestjs/platform-ws'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)

  app.useWebSocketAdapter(new WsAdapter(app))

  await app.listen(3000)

  console.log('API running on http://localhost:3000')
}

bootstrap()
