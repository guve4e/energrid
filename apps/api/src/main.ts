import 'dotenv/config'
import { NestFactory } from '@nestjs/core'
import { AppModule } from './app/app.module'
import { WsAdapter } from '@nestjs/platform-ws'

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: ['log', 'warn', 'error'],
  })

  app.useWebSocketAdapter(new WsAdapter(app))

  const port = process.env.PORT || 3000
  await app.listen(port, '0.0.0.0')

  console.log(`Energrid API running on port ${port}`)
}

bootstrap()
