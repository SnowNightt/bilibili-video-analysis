import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
  });
  app.setGlobalPrefix('api');
  app.enableCors({
    origin: true,
    credentials: false,
  });

  const port = Number(process.env.PORT ?? 3000);
  await app.listen(port, '127.0.0.1');
  Logger.log(`Backend API listening on http://127.0.0.1:${port}/api`, 'Bootstrap');
}

void bootstrap();
