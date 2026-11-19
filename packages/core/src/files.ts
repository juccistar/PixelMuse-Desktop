import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, createWriteStream, lstatSync, realpathSync, type WriteStream } from "node:fs";
import { link, mkdir, open, readFile, readdir, rename, rm, stat, unlink } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { finished } from "node:stream/promises";
import sharp from "sharp";

/** 托管存储的有界资源限制；取消由 Backend 的 AbortController 提供。 */
export interface AssetStoreOptions {
  maxImageBytes?: number;
  maxImagePixels?: number;
  maxBufferedBytes?: number;
  maxExportBytes?: number;
}
/** 导出参数只由 Backend 生成，不接收 renderer 路径。 */
export interface ExportStreamOptions { signal?: AbortSignal; idempotencyKey?: string; maxBytes?: number }
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.tif', '.tiff', '.avif']);
const NAMESPACES = new Set(['assets', 'outputs', 'exports', 'edits', 'layers', 'thumbs', 'tmp', 'suite-forge', 'models', 'patterns', 'print-packs', 'drafts']);

export class LocalAssetStore {
  private readonly root: string;
  private readonly limits: Required<AssetStoreOptions>;

  /** root 只能来自 Backend 管理的数据目录。所有文件 API 也再次检查实际路径。 */
  public constructor(root: string, options: AssetStoreOptions = {}) {
    this.root = resolve(root);
    this.limits = { maxImageBytes: 64 * 1024 * 1024, maxImagePixels: 100_000_000,
      maxBufferedBytes: 256 * 1024 * 1024, maxExportBytes: 2 * 1024 * 1024 * 1024, ...options };
    if (Object.values(this.limits).some(value => !Number.isSafeInteger(value) || value <= 0)) throw new Error('Invalid storage limits');
  }

  /** 创建受管理命名空间；拒绝根目录或父目录被链接重定向。 */
  public async initialize(): Promise<void> {
    this.assertRealPath(this.root);
    await mkdir(this.root, { recursive: true });
    this.assertRealPath(this.root);
    for (const part of NAMESPACES) {
      const directory = this.absolute(part);
      await mkdir(directory, { recursive: true });
      this.assertRealPath(directory);
    }
  }

  public async putAsset(projectId: string, originalName: string, content: Buffer, options: { signal?: AbortSignal } = {}): Promise<{ path: string; hash: string }> {
    this.assertSingleSegment(projectId, "projectId");
    const hash = createHash("sha256").update(content).digest("hex");
    const extension = this.safeExtension(originalName);
    const relativePath = join("assets", projectId, `${randomUUID()}-${hash.slice(0, 12)}${extension}`);
    await this.write(relativePath, content, options);
    return { path: relativePath, hash };
  }

  public async putOutput(projectId: string, content: Buffer, extension = ".png", idempotencyKey?: string, options: { signal?: AbortSignal } = {}): Promise<{ path: string; hash: string }> {
    this.assertSingleSegment(projectId, "projectId");
    const hash = createHash("sha256").update(content).digest("hex");
    const name = idempotencyKey
      ? `${createHash("sha256").update(idempotencyKey).digest("hex")}${this.safeExtension(extension)}`
      : `${randomUUID()}-${hash.slice(0, 12)}${this.safeExtension(extension)}`;
    const relativePath = join("outputs", projectId, name);
    await this.write(relativePath, content, options);
    return { path: relativePath, hash };
  }

  /**
   * 流式导出：ZIP 等大体量产物边生成边落盘，不再把全部内容聚合进内存。
   * 调用方在 open 回调中向可写流灌数据，须在数据全部写完（流 close/finish）后才 resolve；
   * 失败时由 writeStream 清理临时文件，不残留半成品。
   */
  public async putExportStream(projectId: string, produce: (destination: WriteStream) => Promise<void>, options: ExportStreamOptions = {}): Promise<{ path: string }> {
    this.assertSingleSegment(projectId, 'Project id');
    const name = options.idempotencyKey ? createHash('sha256').update(options.idempotencyKey).digest('hex') : randomUUID();
    const relativePath = join('exports', projectId, `${name}.zip`);
    await this.writeStream(relativePath, produce, options);
    return { path: relativePath };
  }

  public async putEditArtifact(projectId: string, sessionId: string, turnId: string, name: string, content: Buffer, options: { signal?: AbortSignal } = {}): Promise<{ path: string; hash: string }> {
    this.assertSingleSegment(projectId, "projectId");
    this.assertSingleSegment(sessionId, "sessionId");
    this.assertSingleSegment(turnId, "turnId");
    this.assertSingleSegment(name, "name");
    const hash = createHash("sha256").update(content).digest("hex");
    const relativePath = join("edits", projectId, sessionId, turnId, `${name}-${hash.slice(0, 12)}${this.safeExtension(name)}`);
    await this.write(relativePath, content, options);
    return { path: relativePath, hash };
  }

  public async putEditReferenceAsset(projectId: string, sessionId: string, name: string, content: Buffer, options: { signal?: AbortSignal } = {}): Promise<{ path: string; hash: string }> {
    this.assertSingleSegment(projectId, "projectId");
    this.assertSingleSegment(sessionId, "sessionId");
    const hash = createHash("sha256").update(content).digest("hex");
    const relativePath = join("edits", projectId, sessionId, "references", `${randomUUID()}-${hash.slice(0, 12)}${this.safeExtension(name)}`);
    await this.write(relativePath, content, options);
    return { path: relativePath, hash };
  }

  /** 分层导出产物（元素图层 PNG、带孔洞背景层与 PSD）；按 layerExportId 聚合，随项目删除一并清理。 */
  public async putLayerArtifact(projectId: string, layerExportId: string, name: string, content: Buffer, extension = ".png", options: { signal?: AbortSignal } = {}): Promise<{ path: string; hash: string }> {
    this.assertSingleSegment(projectId, "projectId");
    this.assertSingleSegment(layerExportId, "layerExportId");
    this.assertSingleSegment(name, "name");
    const hash = createHash("sha256").update(content).digest("hex");
    const relativePath = join("layers", projectId, layerExportId, `${name}-${hash.slice(0, 12)}${this.safeExtension(extension)}`);
    await this.write(relativePath, content, options);
    return { path: relativePath, hash };
  }

  /** 套图反推来源图：不入项目，按 job 聚合到 suite-forge 命名空间；失败重试需重读源图，故不随任务终态删除，当前无自动回收。 */
  public async putSuiteForgeSource(jobId: string, originalName: string, content: Buffer, options: { signal?: AbortSignal } = {}): Promise<{ path: string; hash: string }> {
    this.assertSingleSegment(jobId, "jobId");
    const hash = createHash("sha256").update(content).digest("hex");
    const relativePath = join("suite-forge", jobId, `${randomUUID()}-${hash.slice(0, 12)}${this.safeExtension(originalName)}`);
    await this.write(relativePath, content, options);
    return { path: relativePath, hash };
  }

  /** 模特参考脸：每模特至多一张身份基准图，按 model 聚合；重复上传时旧文件由调用方覆盖语义（路径随 hash 变化，孤儿文件可容忍）。 */
  public async putModelReferenceFace(modelId: string, originalName: string, content: Buffer, options: { signal?: AbortSignal } = {}): Promise<{ path: string; hash: string }> {
    this.assertSingleSegment(modelId, "modelId");
    const hash = createHash("sha256").update(content).digest("hex");
    const relativePath = join("models", modelId, `reference-${hash.slice(0, 12)}${this.safeExtension(originalName)}`);
    await this.write(relativePath, content, options);
    return { path: relativePath, hash };
  }

  /** 模选定妆照：不入项目，按模特与 job 聚合；文件随模特删除级联清理。扩展名跟随产物真实格式。 */
  public async putModelPortrait(modelId: string, jobId: string, content: Buffer, extension = ".png", options: { signal?: AbortSignal } = {}): Promise<{ path: string; hash: string }> {
    this.assertSingleSegment(modelId, "modelId");
    this.assertSingleSegment(jobId, "jobId");
    const hash = createHash("sha256").update(content).digest("hex");
    const relativePath = join("models", modelId, "casts", jobId, `${randomUUID()}-${hash.slice(0, 12)}${this.safeExtension(extension) || ".png"}`);
    await this.write(relativePath, content, options);
    return { path: relativePath, hash };
  }

  /** 花型产物：提取结果、起稿候选或上传的花型文件；按 pattern 聚合，随花型删除级联清理。 */
  public async putPatternArtifact(patternId: string, name: string, content: Buffer, extension = ".png", options: { signal?: AbortSignal } = {}): Promise<{ path: string; hash: string }> {
    this.assertSingleSegment(patternId, "patternId");
    this.assertSingleSegment(name, "name");
    const hash = createHash("sha256").update(content).digest("hex");
    const relativePath = join("patterns", patternId, `${name}-${hash.slice(0, 12)}${this.safeExtension(extension)}`);
    await this.write(relativePath, content, options);
    return { path: relativePath, hash };
  }

  /** 提取/起稿的源图留痕：同 job 的源图与产物共居 patterns/<patternId>/，保证来源可追溯。 */
  public async putPatternSource(patternId: string, originalName: string, content: Buffer, options: { signal?: AbortSignal } = {}): Promise<{ path: string; hash: string }> {
    return this.putPatternArtifact(patternId, "source", content, this.safeExtension(originalName) || ".png", options);
  }

  /**
   * 创作草稿的参考或改稿笔迹媒体；按 draft 聚合在 `drafts/<draftId>/media|annotations/`。
   * 上传与花型库引用都拷贝为草稿自有快照，原花型改名/删除不改写已提交批次。
   */
  public async putDraftMedia(draftId: string, role: "REFERENCE" | "ANNOTATION", originalName: string, content: Buffer, options: { signal?: AbortSignal } = {}): Promise<{ path: string; hash: string }> {
    this.assertSingleSegment(draftId, "draftId");
    const hash = createHash("sha256").update(content).digest("hex");
    const folder = role === "ANNOTATION" ? "annotations" : "media";
    const relativePath = join("drafts", draftId, folder, `${randomUUID()}-${hash.slice(0, 12)}${this.safeExtension(originalName)}`);
    await this.write(relativePath, content, options);
    return { path: relativePath, hash };
  }

  /** 创作候选图稿：以 candidateId 稳定寻址，路径不因重试变化；候选像素一经写入不可变。 */
  public async putDraftCandidate(draftId: string, candidateId: string, content: Buffer, extension = ".png", options: { signal?: AbortSignal } = {}): Promise<{ path: string; hash: string }> {
    this.assertSingleSegment(draftId, "draftId");
    this.assertSingleSegment(candidateId, "candidateId");
    const hash = createHash("sha256").update(content).digest("hex");
    const relativePath = join("drafts", draftId, "candidates", `${candidateId}${this.safeExtension(extension)}`);
    await this.write(relativePath, content, { ...options, immutable: true });
    return { path: relativePath, hash };
  }

  /** 永久删除草稿的全部本地产物（drafts/<draftId>/ 整目录）；正式花型路径不在该命名空间下，不会被连带删除。 */
  public async deleteDraft(draftId: string): Promise<void> {
    this.assertSingleSegment(draftId, "Draft id");
    await this.deleteNamespaceChild("drafts", draftId);
  }

  /** 规格包产物（印刷图稿 PNG 与 manifest/ZIP）；按 printPack 聚合，随规格包删除级联清理。 */
  public async putPrintPackArtifact(printPackId: string, name: string, content: Buffer, extension = ".png", options: { signal?: AbortSignal } = {}): Promise<{ path: string; hash: string }> {
    this.assertSingleSegment(printPackId, "printPackId");
    this.assertSingleSegment(name, "name");
    const hash = createHash("sha256").update(content).digest("hex");
    const relativePath = join("print-packs", printPackId, `${name}-${hash.slice(0, 12)}${this.safeExtension(extension)}`);
    await this.write(relativePath, content, options);
    return { path: relativePath, hash };
  }

  /** 缩略图按内容 hash 寻址：同一张图跨项目共享一份，删除项目不影响派生缓存。 */
  public thumbnailPath(hash: string): string {
    if (!/^[a-f0-9]{64}$/i.test(hash)) throw new Error('Invalid thumbnail content hash');
    return join("thumbs", `${hash}.webp`);
  }

  public async putThumbnail(hash: string, content: Buffer, options: { signal?: AbortSignal } = {}): Promise<string> {
    const relativePath = this.thumbnailPath(hash);
    await this.write(relativePath, content, options);
    return relativePath;
  }

  public async hasThumbnail(hash: string): Promise<boolean> {
    return this.exists(this.thumbnailPath(hash));
  }

  /** 有界读取；平铺 v1/v2 引用仍直接相对于 root 解析。 */
  public async read(relativePath: string, options: { signal?: AbortSignal; maxBytes?: number } = {}): Promise<Buffer> {
    options.signal?.throwIfAborted();
    const filename = this.absolute(relativePath);
    const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await handle.stat();
      const limit = options.maxBytes ?? this.limits.maxBufferedBytes;
      if (!Number.isSafeInteger(limit) || limit <= 0 || limit > this.limits.maxBufferedBytes || !info.isFile() || info.nlink !== 1 || info.size > limit) throw new Error('Managed file exceeds buffered read limit or is linked');
      const content = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < content.length) {
        options.signal?.throwIfAborted();
        const { bytesRead } = await handle.read(content, offset, Math.min(1024 * 1024, content.length - offset), offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead || (await handle.stat()).size > info.size) throw new Error('Managed file changed during buffered read');
      options.signal?.throwIfAborted();
      this.assertRealPath(filename);
      return content.subarray(0, offset);
    } finally { await handle.close(); }
  }

  public stream(relativePath: string, options: { signal?: AbortSignal } = {}) {
    options.signal?.throwIfAborted();
    return createReadStream(this.absolute(relativePath), { signal: options.signal });
  }

  public async size(relativePath: string): Promise<number> {
    return (await stat(this.absolute(relativePath))).size;
  }

  public async exists(relativePath: string): Promise<boolean> {
    try { return (await stat(this.absolute(relativePath))).isFile(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }

  public async delete(relativePath: string): Promise<void> {
    try { await unlink(this.absolute(relativePath)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }

  /** 完整解码检查上传与 Provider 图片；先限制字节/像素，不改变源像素或生成 raw 大缓冲。 */
  public async inspectImage(content: Buffer, signal?: AbortSignal): Promise<{ width: number; height: number; format: string; hasAlpha: boolean }> {
    signal?.throwIfAborted();
    if (content.byteLength > this.limits.maxImageBytes) throw new Error('Image exceeds byte limit');
    const image = sharp(content, { limitInputPixels: this.limits.maxImagePixels, animated: true, failOn: 'warning' });
    try {
      const metadata = await image.metadata();
      signal?.throwIfAborted();
      if (!metadata.width || !metadata.height || !metadata.format || metadata.width * metadata.height > this.limits.maxImagePixels) throw new Error('Image exceeds pixel limit or has invalid dimensions');
      // metadata 只读头；stats 会遍历全部页面的像素，由 libvips 聚合而非返回整张 raw Buffer。
      // Sharp 的原生 stats 无 AbortSignal 接口；等待有界工作结束再检查取消，不能提前返回并留下后台解码。
      await image.stats();
      signal?.throwIfAborted();
      return { width: metadata.width, height: metadata.height, format: metadata.format, hasAlpha: metadata.hasAlpha ?? false };
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    } finally { image.destroy(); }
  }

  /**
   * 永久删除项目的全部本地产物。
   *
   * projectId 来自 URL 参数并直接参与拼路径，是路径穿越的高危入口：`../`、反斜杠或
   * 绝对路径都会改变删除目标，而 `rm recursive + force` 会把误伤静默放大。这里强制
   * projectId 为单段目录名，并要求解析后的目标位于对应资源目录（<root>/<part>/）之下。
   */
  public async deleteProject(projectId: string): Promise<void> {
    this.assertSingleSegment(projectId, "Project id");
    await Promise.all(["assets", "outputs", "exports", "edits", "layers"].map((part) => this.deleteNamespaceChild(part, projectId)));
  }

  /** 永久删除模特的全部本地文件：参考脸与按 job 聚合的全部定妆照（models/<modelId>/ 整目录）。 */
  public async deleteModel(modelId: string): Promise<void> {
    this.assertSingleSegment(modelId, "Model id");
    await this.deleteNamespaceChild("models", modelId);
  }

  /** 永久删除花型的全部本地文件：源图留痕与花型产物（patterns/<patternId>/ 整目录）。 */
  public async deletePattern(patternId: string): Promise<void> {
    this.assertSingleSegment(patternId, "Pattern id");
    await this.deleteNamespaceChild("patterns", patternId);
  }

  /** 永久删除规格包的全部本地文件（print-packs/<printPackId>/ 整目录）。 */
  public async deletePrintPack(printPackId: string): Promise<void> {
    this.assertSingleSegment(printPackId, "Print pack id");
    await this.deleteNamespaceChild("print-packs", printPackId);
  }

  /** id 来自 URL 参数并直接参与拼路径，是路径穿越的高危入口：强制单段目录名，杜绝 `../` 等形态进入递归删除。 */
  private assertSingleSegment(id: string, label: string): void {
    if (!id || id === '.' || id.includes('/') || id.includes('\\') || id.includes('..') || /[:\x00-\x1f]/.test(id) || /[. ]$/.test(id) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(id) || isAbsolute(id)) {
      throw new Error(`${label} must be a single path segment`);
    }
  }

  /** 删除 <root>/<namespace>/<id>/ 整目录：目标必须解析回对应资源目录之下，防止越界递归删除。 */
  private async deleteNamespaceChild(namespace: string, id: string): Promise<void> {
    const target = this.absolute(join(namespace, id));
    const pathFromNamespace = relative(this.absolute(namespace), target);
    if (pathFromNamespace.startsWith("..") || isAbsolute(pathFromNamespace)) throw new Error("Asset path escapes storage root");
    await this.assertTree(target);
    await rm(target, { recursive: true, force: true });
  }

  /** 仅 Backend 可使用的实际路径；renderer 不得接收此返回值。 */
  public absolute(relativePath: string): string {
    if (!relativePath || isAbsolute(relativePath) || /^[\\/]/.test(relativePath) || /[:\x00-\x1f]/.test(relativePath)) throw new Error('Asset path must be relative to the storage root');
    const segments = relativePath.split(/[\\/]/);
    for (const segment of segments) this.assertSingleSegment(segment, 'Asset path');
    const absolute = resolve(this.root, ...segments);
    const pathFromRoot = relative(this.root, absolute);
    if (pathFromRoot === '' || pathFromRoot === '..' || pathFromRoot.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(pathFromRoot)) throw new Error('Asset path escapes storage root');
    this.assertRealPath(absolute);
    return absolute;
  }

  private assertRealPath(filename: string): void {
    const parsed = parse(resolve(filename));
    let current = parsed.root;
    for (const segment of resolve(filename).slice(parsed.root.length).split(/[\\/]/).filter(Boolean)) {
      current = join(current, segment);
      let info;
      try { info = lstatSync(current); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
      if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1)) throw new Error('Linked managed paths are forbidden');
      const actual = realpathSync.native(current);
      if (relative(actual, current) !== '') throw new Error('Managed path was redirected');
    }
  }

  private async assertTree(directory: string): Promise<void> {
    this.assertRealPath(directory);
    let children;
    try { children = await readdir(directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    for (const child of children) {
      const filename = join(directory, child.name);
      this.assertRealPath(filename);
      if (child.isDirectory()) await this.assertTree(filename);
    }
  }

  private async prepareDestination(relativePath: string): Promise<string> {
    const destination = this.absolute(relativePath);
    await mkdir(dirname(destination), { recursive: true });
    this.assertRealPath(destination);
    return destination;
  }

  private async write(relativePath: string, content: Buffer, options: { signal?: AbortSignal; immutable?: boolean } = {}): Promise<void> {
    options.signal?.throwIfAborted();
    if (content.byteLength > this.limits.maxBufferedBytes || (IMAGE_EXTENSIONS.has(extname(relativePath).toLowerCase()) && content.byteLength > this.limits.maxImageBytes)) throw new Error('Managed content exceeds byte limit');
    const destination = await this.prepareDestination(relativePath);
    const temporary = this.absolute(join('tmp', randomUUID()));
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try {
        await handle.writeFile(content, { signal: options.signal });
        await handle.sync();
      } finally { await handle.close(); }
      options.signal?.throwIfAborted();
      this.assertRealPath(destination);
      this.assertRealPath(temporary);
      if (options.immutable) {
        try { await link(temporary, destination); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const previous = await this.read(relativePath);
          if (!previous.equals(content)) throw new Error('Immutable managed artifact already exists with different content');
        }
      } else { await rename(temporary, destination); }
    } finally { await rm(temporary, { force: true }); }
  }

  /** 流失败/取消/超限都会等待关闭再清理；发布前 fsync，不留下可见半成品。 */
  private async writeStream(relativePath: string, produce: (destination: WriteStream) => Promise<void>, options: ExportStreamOptions = {}): Promise<void> {
    options.signal?.throwIfAborted();
    const limit = options.maxBytes ?? this.limits.maxExportBytes;
    if (!Number.isSafeInteger(limit) || limit <= 0 || limit > this.limits.maxExportBytes) throw new Error('Invalid export byte limit');
    const destination = await this.prepareDestination(relativePath);
    // mkdir 期间的取消事件尚无流可销毁，必须在创建临时文件前再次检查。
    options.signal?.throwIfAborted();
    const temporary = this.absolute(join('tmp', randomUUID()));
    const stream = createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
    const completion = finished(stream);
    void completion.catch(() => undefined);
    let byteCount = 0;
    const originalWrite = stream.write.bind(stream);
    stream.write = ((chunk: unknown, encoding?: unknown, callback?: unknown) => {
      const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding as BufferEncoding : undefined) : (chunk as Uint8Array).byteLength;
      byteCount += bytes;
      if (byteCount > limit) { stream.destroy(new Error('Export exceeds byte limit')); return false; }
      return (originalWrite as (...args: unknown[]) => boolean)(chunk, encoding, callback);
    }) as typeof stream.write;
    const abort = () => stream.destroy(options.signal?.reason instanceof Error ? options.signal.reason : new Error('Export cancelled'));
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      await Promise.race([Promise.resolve().then(() => {
        options.signal?.throwIfAborted();
        return produce(stream);
      }), completion.then(() => new Promise<never>(() => undefined))]);
      if (!stream.writableEnded) stream.end();
      await completion;
      options.signal?.throwIfAborted();
      this.assertRealPath(temporary);
      const handle = await open(temporary, 'r+');
      try {
        if ((await handle.stat()).size > limit) throw new Error('Export exceeds byte limit');
        await handle.sync();
      } finally { await handle.close(); }
      this.assertRealPath(destination);
      await rename(temporary, destination);
    } finally {
      options.signal?.removeEventListener('abort', abort);
      stream.destroy();
      await completion.catch(() => undefined);
      await rm(temporary, { force: true });
    }
  }

  private safeExtension(value: string): string {
    const match = /\.[a-zA-Z0-9]{1,8}$/.exec(value);
    return match ? match[0].toLowerCase() : "";
  }
}
