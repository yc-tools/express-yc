# @yc-tools/express-yc-runtime

Runtime adapter for Express.js on Yandex Cloud Functions. A thin wrapper around [serverless-http](https://www.npmjs.com/package/serverless-http), used by the artifacts that [@yc-tools/express-yc](https://www.npmjs.com/package/@yc-tools/express-yc) builds, and usable directly in hand-written function entry points.

## Usage

```js
import { createFunctionHandler } from '@yc-tools/express-yc-runtime';
import app from './app.js';

export const handler = createFunctionHandler(app);
```

## API

### `createFunctionHandler(app, options?)`

Wraps an Express app (or any Node.js http-compatible application/server) into a Yandex Cloud Functions handler.

By default, responses with common binary content types (`image/*`, `font/*`, `audio/*`, `video/*`, `application/pdf`, `application/zip`, `application/octet-stream`) are base64-encoded so they are not corrupted by API Gateway; compressed responses (`gzip`/`deflate`/`br`) are detected automatically. Pass `options.binary` (boolean, content-type list, or predicate — see the serverless-http docs) to override, along with any other serverless-http option.

## Requirements

- Node.js >= 20

## License

MIT
