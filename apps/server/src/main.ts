import 'dotenv/config';
import { serve } from '@hono/node-server';
import { app, config, disposeApp } from './app.js';

const server = serve({
  fetch: app.fetch,
  port: config.port,
});

console.info(`server started at http://localhost:${config.port}`);

const shutdown = () => {
  server.close(() => {
    void disposeApp().finally(() => process.exit(0));
  });
};

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
