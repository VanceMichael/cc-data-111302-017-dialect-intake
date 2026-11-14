#!/usr/bin/env node
// 接收流程命令行：
//   intake receive <文件> --name <逻辑名> [--state <目录>] [--schema <契约json>]
//   intake confirm <runId> --fingerprint <指纹> [--operator <人>] [--reason <说明>]
//   intake reinterpret <runId> --delimiter <,|;|\t|||> [--operator] [--reason]
//   intake report <runId>
//   intake runs | confirmations | published
// 所有写入都在 state 目录内，默认 .local/intake。

import { readFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, basename } from 'node:path';
import { IntakeStore } from './store.mjs';
import { loadSchema } from './schema.mjs';
import { receiveFile, confirmCandidate, reinterpretWith } from './receive.mjs';
import { buildRunReport } from './report.mjs';
import { describeDialect } from './dialect.mjs';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    } else positional.push(token);
  }
  return { positional, flags };
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;
  const stateDir = resolve(flags.state || '.local/intake');
  const store = new IntakeStore(stateDir);
  await store.init();
  const schemaPath = flags.schema || new URL('../../fixtures/schema.json', import.meta.url).pathname;
  const schema = loadSchema(JSON.parse(await readFile(schemaPath, 'utf8')));

  if (command === 'receive') {
    const filePath = rest[0];
    if (!filePath) throw new Error('用法：intake receive <文件> --name <逻辑名>');
    const name = flags.name || basename(filePath);
    const run = await receiveFile({
      store,
      name,
      byteChunks: createReadStream(filePath),
      schema,
      operator: flags.operator || 'system',
    });
    printSummary(run);
    return;
  }

  if (command === 'confirm') {
    const runId = rest[0];
    if (!runId || !flags.fingerprint) throw new Error('用法：intake confirm <runId> --fingerprint <指纹>');
    const run = await confirmCandidate({ store, runId, fingerprint: String(flags.fingerprint), operator: flags.operator || 'staff', reason: flags.reason });
    printSummary(run);
    return;
  }

  if (command === 'reinterpret') {
    const runId = rest[0];
    if (!runId || !flags.delimiter) throw new Error('用法：intake reinterpret <runId> --delimiter <分隔符>');
    const run = await reinterpretWith({
      store,
      runId,
      dialectChoice: { delimiter: String(flags.delimiter) },
      operator: flags.operator || 'staff',
      reason: flags.reason,
    });
    printSummary(run);
    return;
  }

  if (command === 'report') {
    const run = await store.loadRun(rest[0]);
    const { markdown } = buildRunReport(run, {
      confirmations: await store.listConfirmations(),
      publications: await store.listPublished(),
    });
    process.stdout.write(markdown);
    return;
  }

  if (command === 'runs') {
    for (const runId of await store.listRuns()) {
      const run = await store.loadRun(runId);
      process.stdout.write(`${runId}\t${run.name}\t${run.status}\t${run.sha256.slice(0, 12)}\n`);
    }
    return;
  }

  if (command === 'confirmations') {
    for (const record of await store.listConfirmations()) {
      process.stdout.write(`${record.key}\t${record.name}\t${record.operator}\t${record.confirmedAt}\n`);
    }
    return;
  }

  if (command === 'published') {
    for (const record of (await store.listPublished()).sort((a, b) => a.version - b.version)) {
      process.stdout.write(`${record.name}\t${record.versionId}\t${record.sha256.slice(0, 12)}\t${record.operator}\n`);
    }
    return;
  }

  process.stdout.write('未知命令。可用：receive | confirm | reinterpret | report | runs | confirmations | published\n');
  process.exitCode = 1;
}

function printSummary(run) {
  const out = {
    runId: run.runId,
    name: run.name,
    sha256: run.sha256,
    status: run.status,
    decision: run.decision?.kind,
    candidates: run.candidates.map((c) => ({ dialect: describeDialect(c.dialect), fingerprint: c.fingerprint, weak: c.weak })),
    conflict: run.conflict ?? null,
    publication: run.publication ?? null,
    missingEvidence: run.missingEvidence,
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main().catch((error) => {
  process.stderr.write(`接收流程失败：${error.message}\n`);
  process.exitCode = 1;
});
