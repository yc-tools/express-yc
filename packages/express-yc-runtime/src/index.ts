import serverlessHttp from 'serverless-http';

/**
 * Minimal structural type for anything serverless-http can wrap: an Express
 * app (or any Node.js request listener), a framework application object, or a
 * plain http server.
 */
export type ServerlessApplication = Parameters<typeof serverlessHttp>[0];

export type ServerlessHandlerOptions = NonNullable<Parameters<typeof serverlessHttp>[1]>;

/**
 * Content types whose response bodies are base64-encoded so they survive the
 * API Gateway round-trip intact. Compressed responses (gzip/deflate/br
 * content-encoding) are always detected as binary by serverless-http itself.
 */
const DEFAULT_BINARY_CONTENT_TYPES = [
  'application/octet-stream',
  'application/pdf',
  'application/zip',
  'audio/*',
  'font/*',
  'image/*',
  'video/*',
];

/**
 * Wrap an Express (or any Node.js http-compatible) app for use as a
 * Yandex Cloud Functions handler.
 *
 * By default, responses with common binary content types (images, fonts,
 * audio/video, pdf, zip, octet-stream) are base64-encoded so they are not
 * corrupted by API Gateway. Override via `options.binary` (see the
 * serverless-http docs: boolean, content-type list, or predicate).
 *
 * Usage in your function entry point:
 *
 *   import { createFunctionHandler } from '@yc-tools/express-yc-runtime';
 *   import app from './app.js';
 *   export const handler = createFunctionHandler(app);
 */
export function createFunctionHandler(
  app: ServerlessApplication,
  options?: ServerlessHandlerOptions,
): ReturnType<typeof serverlessHttp> {
  return serverlessHttp(app, {
    binary: DEFAULT_BINARY_CONTENT_TYPES,
    ...options,
  });
}
