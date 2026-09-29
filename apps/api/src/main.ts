import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { join } from 'path';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  await app.register(multipart, {
    // LinkedIn's full data-export ZIP (used by the connections/messages
    // import) can run well past 20MB with message history included.
    limits: { fileSize: 150 * 1024 * 1024 },
  });
  await app.register(fastifyStatic, {
    root: join(process.cwd(), '..', '..', 'data', 'uploads'),
    prefix: '/uploads/',
  });

  app.enableCors({ origin: true });

  const port = process.env.PORT ?? 4100;
  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(`job-tracker api listening on ${port}`);
}

bootstrap();
