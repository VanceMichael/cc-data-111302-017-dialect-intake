// 接收侧持久化：全部落在明确的本地目录（默认 .local/intake）。
// - raw/：原始字节内容寻址（sha256），同名文件各自独立，不互相覆盖
// - runs/：每次接收的完整记录（候选、依据、状态机事件）
// - confirmations/：人工确认记录，键为 内容哈希+解释指纹，同名文件不可复用
// - canonical/：逐行规范记录（每轮尝试一个不可变文件）
// - published/：已发布版本，只追加不修改；index.json 维护当前版本指针

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';

function nowIso() {
  return new Date().toISOString();
}

export function newRunId(name) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rand = createHash('sha1').update(`${name}${stamp}${Math.random()}`).digest('hex').slice(0, 8);
  return `run-${stamp}-${rand}`;
}

export class IntakeStore {
  constructor(rootDir) {
    this.root = rootDir;
    this.rawDir = join(rootDir, 'raw');
    this.runDir = join(rootDir, 'runs');
    this.confirmDir = join(rootDir, 'confirmations');
    this.canonicalDir = join(rootDir, 'canonical');
    this.publishDir = join(rootDir, 'published');
  }

  async init() {
    for (const dir of [this.root, this.rawDir, this.runDir, this.confirmDir, this.canonicalDir, this.publishDir]) {
      await mkdir(dir, { recursive: true });
    }
  }

  rawPath(sha256) {
    return join(this.rawDir, `${sha256}.bin`);
  }

  // 流式保存原始字节并计算哈希；调用方不需要把整份文件保留在内存里。
  async saveRaw(byteChunks, { name, sizeHint } = {}) {
    const hash = createHash('sha256');
    const tempName = `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tempPath = join(this.rawDir, tempName);
    let size = 0;
    const sink = createWriteStream(tempPath);
    const tap = async function* (source) {
      for await (const chunk of source) {
        size += chunk.length;
        hash.update(chunk);
        yield chunk;
      }
    };
    await pipeline(tap(byteChunks), sink);
    const sha256 = hash.digest('hex');
    const finalPath = this.rawPath(sha256);
    await rename(tempPath, finalPath); // 同内容天然去重，不同内容哈希不同绝不覆盖
    return { sha256, size, path: finalPath, name, savedAt: nowIso() };
  }

  async openRaw(sha256) {
    return readFile(this.rawPath(sha256));
  }

  // 流式取回原始字节，供全量复核使用，避免整份文件驻留内存。
  streamRaw(sha256) {
    return createReadStream(this.rawPath(sha256));
  }

  async saveRun(run) {
    await writeFile(join(this.runDir, `${run.runId}.json`), JSON.stringify(run, null, 2));
    return run;
  }

  async loadRun(runId) {
    return JSON.parse(await readFile(join(this.runDir, `${runId}.json`), 'utf8'));
  }

  async listRuns() {
    const files = await readdir(this.runDir);
    return files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort();
  }

  canonicalPath(sha256, attempt) {
    return join(this.canonicalDir, `${sha256}-attempt${attempt}.jsonl`);
  }

  createCanonicalSink(sha256, attempt) {
    return createWriteStream(this.canonicalPath(sha256, attempt));
  }

  // 确认记录同时绑定内容哈希与解释指纹；任一不匹配即视为不同交付，不能复用。
  confirmationKey(sha256, fingerprint) {
    return `${sha256}:${createHash('sha256').update(fingerprint).digest('hex').slice(0, 16)}`;
  }

  confirmationPath(key) {
    return join(this.confirmDir, `${key.replace(':', '_')}.json`);
  }

  async saveConfirmation(record) {
    const key = this.confirmationKey(record.sha256, record.fingerprint);
    const path = this.confirmationPath(key);
    const payload = { ...record, key, confirmedAt: nowIso() };
    await writeFile(path, JSON.stringify(payload, null, 2));
    return payload;
  }

  async findConfirmation(sha256, fingerprint) {
    try {
      const record = JSON.parse(await readFile(this.confirmationPath(this.confirmationKey(sha256, fingerprint)), 'utf8'));
      if (record.sha256 !== sha256 || record.fingerprint !== fingerprint) return null;
      return record;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async listConfirmations() {
    const files = await readdir(this.confirmDir);
    return Promise.all(
      files.filter((f) => f.endsWith('.json')).map((f) => readFile(join(this.confirmDir, f), 'utf8').then((t) => JSON.parse(t))),
    );
  }

  async nextVersion(name) {
    const index = await this.readPublishIndex();
    const current = index.byName[name];
    return current ? current.version + 1 : 1;
  }

  async readPublishIndex() {
    try {
      return JSON.parse(await readFile(join(this.publishDir, 'index.json'), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return { byName: {} };
      throw error;
    }
  }

  // 发布不可变版本：历史文件保留，只移动 index 指针；superseded 记录可追溯。
  async publish({ name, sha256, runId, attempt, canonicalRef, dialect, fingerprint, operator }) {
    const index = await this.readPublishIndex();
    const previous = index.byName[name] || null;
    const version = previous ? previous.version + 1 : 1;
    const versionId = `v${version}`;
    const record = {
      name,
      version,
      versionId,
      sha256,
      runId,
      attempt,
      canonicalRef,
      dialect,
      fingerprint,
      operator: operator || 'system-auto',
      publishedAt: nowIso(),
      supersedes: previous ? { versionId: previous.versionId, sha256: previous.sha256, runId: previous.runId } : null,
    };
    await writeFile(join(this.publishDir, `${name.replace(/[^A-Za-z0-9_.-]/g, '_')}-${versionId}.json`), JSON.stringify(record, null, 2));
    index.byName[name] = { version, versionId, sha256, runId, publishedAt: record.publishedAt };
    await writeFile(join(this.publishDir, 'index.json'), JSON.stringify(index, null, 2));
    return record;
  }

  async listPublished() {
    const files = await readdir(this.publishDir);
    return Promise.all(
      files
        .filter((f) => f.endsWith('.json') && f !== 'index.json')
        .map((f) => readFile(join(this.publishDir, f), 'utf8').then((t) => JSON.parse(t))),
    );
  }
}

export async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, path);
}
