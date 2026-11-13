import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
try { process.loadEnvFile(resolve(root, '.env')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

try {
  const config = await loadConfig({ demo: process.argv.includes('--demo') });
  const app = config.backend === 'local'
    ? await (await import('./index.mjs')).createApp()
    : await (await import('./cloud.mjs')).createCloudApp({ config });
  app.requestTimeout = 120_000;
  app.headersTimeout = 15_000;
  app.keepAliveTimeout = 5_000;
  app.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '포트를 이미 사용 중입니다. PORT 값을 바꾸세요.' : '서버를 실행할 수 없습니다.'); process.exitCode = 1; });
  app.listen(config.port, config.host, () => console.log(`Still · ${config.origin || 'http://127.0.0.1:' + config.port} (${config.backend})`));
  const stop = () => {
    app.close(() => process.exit(0));
    setTimeout(() => { app.closeAllConnections(); process.exit(0); }, 15_000).unref();
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
} catch (error) {
  console.error(/\p{Script=Hangul}/u.test(error.message) ? error.message : '시작 설정을 확인해 주세요. README의 공용 백엔드 연결 항목을 참고하세요.');
  console.error('개인 PC 시연만 하려면 node server/start.mjs --demo 를 실행하세요.');
  process.exitCode = 1;
}
