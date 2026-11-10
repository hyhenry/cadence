import { buildApp } from './app.ts';
import { describeTarget, loadConfig } from './config.ts';

const config = loadConfig();
const { app, close } = await buildApp({ config });
app.log.info(`Cadence connecting to ${describeTarget(config.ha)}`);
await app.listen({ port: config.port, host: config.host });

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await close().catch(() => undefined);
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
