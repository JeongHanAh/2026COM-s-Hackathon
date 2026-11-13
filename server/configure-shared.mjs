import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validatePublicBackend } from './config.mjs';

// This file is committed intentionally. Accept public credentials only.
try {
  const [url, key] = process.argv.slice(2);
  if (!url || !key) throw new Error('사용법: node server/configure-shared.mjs <프로젝트 URL> <publishable 키>');
  const settings = validatePublicBackend({ url, key });
  const path = fileURLToPath(new URL('../shared-backend.json', import.meta.url));
  await writeFile(path, JSON.stringify({ url: settings.url, publishableKey: settings.key }, null, 2) + '\n');
  console.log('shared-backend.json에 공용 연결을 저장했습니다. 이 파일을 GitHub에 함께 올리면 같은 저장소에 연결됩니다.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
