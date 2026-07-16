import { bootstrapApi } from './bootstrap';

interface ParentPort {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): void;
}

const parentPort = (process as NodeJS.Process & { parentPort: ParentPort }).parentPort;

async function run() {
  const api = await bootstrapApi({ port: 0, corsOrigin: 'app://renderer' });
  parentPort.postMessage({ type: 'ready', url: api.url });
  parentPort.on('message', (event) => {
    if ((event.data as { type?: string })?.type === 'shutdown') {
      void api.close().then(() => process.exit(0));
    }
  });
}

void run().catch((error: unknown) => {
  parentPort.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
