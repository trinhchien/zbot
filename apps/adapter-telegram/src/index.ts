import { TelegramAdapter } from './adapter';
import { logger } from '@reunion/shared/logger';
import http from 'node:http';

const adapter = new TelegramAdapter();

// Healthcheck server
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', platform: 'telegram', ts: new Date().toISOString() }));
  } else {
    res.writeHead(404).end();
  }
});
server.listen(3001, () => logger.info('Healthcheck on :3001'));

await adapter.start();

process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down');
  await adapter.stop();
  server.close();
  process.exit(0);
});
