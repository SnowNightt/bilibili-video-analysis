import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import type { AddressInfo } from 'node:net';
import { AppModule } from './app.module';
import { configureGlobalProxy } from './common/proxy';

export interface ApiBootstrapOptions {
  host?: string;
  port?: number;
  corsOrigin?: string | boolean;
}

export interface RunningApi {
  app: NestExpressApplication;
  host: string;
  port: number;
  url: string;
  close(): Promise<void>;
}

export async function bootstrapApi(options: ApiBootstrapOptions = {}): Promise<RunningApi> {
  configureGlobalProxy();
  const host = options.host ?? '127.0.0.1';
  const requestedPort = options.port ?? 3000;
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: true });

  app.setGlobalPrefix('api');
  app.enableCors({ origin: options.corsOrigin ?? true, credentials: false });

  const token = process.env.BVA_API_TOKEN?.trim();
  if (token) {
    app.use((request: Request, response: Response, next: NextFunction) => {
      const publicRequest =
        request.method === 'OPTIONS' ||
        request.path === '/api/health' ||
        (request.method === 'GET' && request.path.startsWith('/api/analysis/assets/'));
      if (publicRequest || request.header('x-bva-token') === token) {
        next();
        return;
      }
      response.status(401).json({ message: '桌面服务鉴权失败。' });
    });
  }

  app.enableShutdownHooks();
  await app.listen(requestedPort, host);
  const address = app.getHttpServer().address() as AddressInfo;
  const url = `http://${host}:${address.port}`;
  Logger.log(`Backend API listening on ${url}/api`, 'Bootstrap');

  return { app, host, port: address.port, url, close: () => app.close() };
}
