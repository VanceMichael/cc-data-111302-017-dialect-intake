import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('..', import.meta.url)));
const cli = join(root, 'src/intake/cli.mjs');

function run(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: cwd || root });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', reject);
  });
}

test('CLI 全链路：receive 挂起 → confirm 发布 → report 可解释 → runs/published 可查', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'intake-cli-'));
  const inputDir = await mkdtemp(join(tmpdir(), 'intake-input-'));
  const input = join(inputDir, 'daily.csv');
  // 内联构造歧义文件：逗号与分号两种合法解释
  await writeFile(input, 'code,amount;value\nA,12;34\nB,56;78\n');
  try {
    const received = await run(['receive', input, '--name', 'daily.csv', '--state', stateDir]);
    assert.equal(received.code, 0, received.stderr);
    const summary = JSON.parse(received.stdout);
    assert.equal(summary.status, 'awaiting_confirmation');
    assert.ok(summary.candidates.length >= 2);
    const fingerprint = summary.candidates.find((c) => c.dialect.includes('分号')).fingerprint;

    const confirmed = await run([
      'confirm', summary.runId, '--fingerprint', fingerprint, '--state', stateDir,
      '--operator', 'cli-tester', '--reason', 'CLI 冒烟确认',
    ]);
    assert.equal(confirmed.code, 0, confirmed.stderr);
    assert.equal(JSON.parse(confirmed.stdout).status, 'accepted');

    const report = await run(['report', summary.runId, '--state', stateDir]);
    assert.equal(report.code, 0);
    assert.match(report.stdout, /接收运行/);
    assert.match(report.stdout, /cli-tester/);
    assert.match(report.stdout, /v1/);

    const runs = await run(['runs', '--state', stateDir]);
    assert.match(runs.stdout, /daily\.csv\taccepted/);
    const published = await run(['published', '--state', stateDir]);
    assert.match(published.stdout, /daily\.csv\tv1/);
    const confirmations = await run(['confirmations', '--state', stateDir]);
    assert.match(confirmations.stdout, /cli-tester/);

    // 未知命令与错误指纹有明确非零退出
    const bad = await run(['confirm', summary.runId, '--fingerprint', 'bogus', '--state', stateDir]);
    assert.notEqual(bad.code, 0);
    assert.match(bad.stderr, /候选集合/);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
    await rm(inputDir, { recursive: true, force: true });
  }
});
