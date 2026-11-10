import { startMockHA } from './server.ts';

const port = Number(process.env.MOCK_PORT ?? 8124);
const mock = await startMockHA({
  port,
  tz: process.env.MOCK_TZ,
  ingressTarget: process.env.MOCK_INGRESS_TARGET ?? 'http://127.0.0.1:8099',
});
console.log(`[mock-ha] token "mock-token"; ingress preview at ${mock.url}/api/hassio_ingress/dev/`);
const stop = () => mock.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
