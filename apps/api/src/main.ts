import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { EnvValidationError } from '@repo/contracts';
import cookieParser from 'cookie-parser';
import { cleanupOpenApiDoc } from 'nestjs-zod';

import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { loadEnv } from './config/env.config';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');

  // 先驗證環境變數再建立應用程式：設定有問題就不要讓服務半殘地起來。
  const env = loadEnv();

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // 錯誤格式由 AllExceptionsFilter 統一產生。
    bufferLogs: false,
  });

  app.disable('x-powered-by');
  app.setGlobalPrefix(env.API_GLOBAL_PREFIX);
  app.enableShutdownHooks();
  app.useGlobalFilters(new AllExceptionsFilter());
  // 認證與 CSRF 都依賴 Cookie，必須在守衛之前解析。
  app.use(cookieParser(env.COOKIE_SECRET));

  // 上傳大小上限同時保護一般 JSON 請求與題庫匯入。
  app.useBodyParser('json', { limit: env.IMPORT_MAX_FILE_SIZE_BYTES });

  app.enableCors({
    origin: env.CORS_ORIGIN.split(',').map((o) => o.trim()),
    // 認證採 HttpOnly Cookie，因此必須允許帶憑證。
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id'],
  });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('題庫分析系統 API')
    .setDescription(
      '選擇題題庫、作答、對答案與 AI 錯題分析系統。\n\n' +
        '所有非 2xx 回應皆採統一格式：{ "error": { code, message, details?, requestId, timestamp } }',
    )
    .setVersion('0.1.0')
    .addCookieAuth('access_token')
    .build();

  // cleanupOpenApiDoc 會把 createZodDto 產生的 schema 正規化成合法的 OpenAPI 文件。
  const document = cleanupOpenApiDoc(SwaggerModule.createDocument(app, swaggerConfig));
  SwaggerModule.setup('docs', app, document, {
    swaggerOptions: { withCredentials: true },
  });

  await app.listen(env.PORT);

  // 只印非機密資訊。
  logger.log(`環境：${env.NODE_ENV}`);
  logger.log(`API：${env.BACKEND_URL}/${env.API_GLOBAL_PREFIX}`);
  logger.log(`Swagger：${env.BACKEND_URL}/docs`);
  logger.log(`AI provider：${env.AI_PROVIDER}／模型：${env.NVIDIA_MODEL}`);
  logger.log(`搜尋 provider：${env.SEARCH_PROVIDER}`);
}

bootstrap().catch((error: unknown) => {
  if (error instanceof EnvValidationError) {
    // 這裡的訊息只含鍵名與規則說明，不含任何變數值。
    console.error('\n啟動失敗：環境變數設定有誤。');
    console.error(error.message);
    console.error('\n請執行 `pnpm bootstrap:env` 補齊自動產生的變數，');
    console.error('並確認 .env 內已填入 NVIDIA_API_KEY、TAVILY_API_KEY、DATABASE_URL。\n');
    process.exit(1);
  }

  console.error('啟動失敗：', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
