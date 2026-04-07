import serverlessHttp from 'serverless-http';

/**
 * Wrap an Express (or any Node.js http-compatible) app for use as a
 * Yandex Cloud Functions handler.
 *
 * Usage in your function entry point:
 *
 *   import { createFunctionHandler } from '@express-yc/runtime';
 *   import app from './app.js';
 *   export const handler = createFunctionHandler(app);
 */
export function createFunctionHandler(app: object): ReturnType<typeof serverlessHttp> {
  return serverlessHttp(app, {
    binary: false,
  });
}
