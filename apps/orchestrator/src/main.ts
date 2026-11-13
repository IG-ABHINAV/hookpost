import { initializeSentry } from '@hookpost/nestjs-libraries/sentry/initialize.sentry';
initializeSentry('orchestrator', true);
import 'source-map-support/register';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
dayjs.extend(utc);

import { NestFactory } from '@nestjs/core';
import { AppModule } from '@hookpost/orchestrator/app.module';
import * as dns from 'node:dns';
import { describeTrialPolicy } from '@hookpost/nestjs-libraries/database/prisma/subscriptions/trial.policy';
dns.setDefaultResultOrder('ipv4first');

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  const port = process.env.ORCHESTRATOR_PORT || 3002;
  await app.listen(port);
  console.log(`Orchestrator health check listening on port ${port}`);
  // The same line the backend prints at startup. publishWithinPlan applies
  // these values to every post; if they differ from the backend's, this
  // process runs on a stale PM2 env (restart it with .env sourced).
  console.log(describeTrialPolicy());
}


bootstrap();
