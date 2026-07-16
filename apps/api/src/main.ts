import 'reflect-metadata';
import { bootstrapApi } from './bootstrap';

async function bootstrap() {
  await bootstrapApi({ port: Number(process.env.PORT ?? 3000) });
}

void bootstrap();
