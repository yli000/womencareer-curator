import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['--test', 'tests/collect.test.mjs'], {
  stdio: 'inherit',
  env: { ...process.env, COLLECT_NETWORK_TEST: '1' },
});
if (result.error) throw result.error;
if (result.signal) throw new Error(`网络测试被信号 ${result.signal} 终止。`);
process.exit(result.status);
