/**
 * Boots the real backend (AppModule) in-process on a random port, configured
 * the way apps/backend/src/main.ts configures it (validation pipe, body
 * limits, cookie parser, exception filters, MCP routes). Only the Temporal
 * client is swapped for FakeTemporal.
 *
 * main.ts calls start() on import, so it cannot be imported here; keep the
 * middleware list below in step with it.
 */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModuleBuilder } from '@nestjs/testing';
import { TemporalService } from 'nestjs-temporal-core';
import { json } from 'express';
import cookieParser from 'cookie-parser';
import { FakeTemporal } from './fake.temporal';
import { Api } from './api';

export interface TestApp {
  app: INestApplication;
  baseUrl: string;
  temporal: FakeTemporal;
  api: Api;
  get<T>(token: any): T;
  close(): Promise<void>;
}

export async function startApp(
  options: {
    override?: (builder: TestingModuleBuilder) => TestingModuleBuilder;
    mcp?: boolean;
    /** Fixed port (the E2E backend); a random free one by default. */
    port?: number;
    /** Nest's logger levels; errors only unless INTEGRATION_LOGS is set. */
    logger?: false | ('log' | 'error' | 'warn' | 'debug' | 'verbose')[];
  } = {}
): Promise<TestApp> {
  // Imported lazily so each test file can adjust process.env first.
  const { AppModule } = await import('@hookpost/backend/app.module');
  const { SubscriptionExceptionFilter } = await import(
    '@hookpost/backend/services/auth/permissions/subscription.exception'
  );
  const { PostValidationExceptionFilter } = await import(
    '@hookpost/backend/api/routes/posts.validation.exception'
  );
  const { HttpExceptionFilter } = await import(
    '@hookpost/nestjs-libraries/services/exception.filter'
  );

  const temporal = new FakeTemporal();
  let builder = Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(TemporalService)
    .useValue(temporal);
  if (options.override) {
    builder = options.override(builder);
  }
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication({
    rawBody: true,
    logger: options.logger ?? (process.env.INTEGRATION_LOGS ? undefined : ['error']),
    // The same CORS policy main.ts sets: the E2E browser calls the API from
    // the frontend's origin, with cookies unless NOT_SECURED is set.
    cors: {
      ...(!process.env.NOT_SECURED ? { credentials: true } : {}),
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'auth',
        'showorg',
        'impersonate',
        'x-copilotkit-runtime-client-gql-version',
      ],
      exposedHeaders: [
        'reload',
        'onboarding',
        'activate',
        'x-copilotkit-runtime-client-gql-version',
        ...(process.env.NOT_SECURED ? ['auth', 'showorg', 'impersonate'] : []),
      ],
      origin: [
        process.env.FRONTEND_URL!,
        'http://localhost:6274',
        ...(process.env.MAIN_URL ? [process.env.MAIN_URL] : []),
      ],
    },
  });

  if (options.mcp) {
    const { startMcp } = await import(
      '@hookpost/nestjs-libraries/chat/start.mcp'
    );
    await startMcp(app);
  }

  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  app.use(['/copilot/{*splat}', '/posts'], (req: any, res: any, next: any) => {
    json({ limit: '50mb' })(req, res, next);
  });
  app.use(cookieParser());
  app.useGlobalFilters(new SubscriptionExceptionFilter());
  app.useGlobalFilters(new PostValidationExceptionFilter());
  app.useGlobalFilters(new HttpExceptionFilter());

  await app.listen(options.port ?? 0, '127.0.0.1');
  const address = app.getHttpServer().address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    app,
    baseUrl,
    temporal,
    api: new Api(baseUrl),
    get: <T>(token: any) => app.get<T>(token, { strict: false }),
    close: async () => {
      await app.close();
    },
  };
}
