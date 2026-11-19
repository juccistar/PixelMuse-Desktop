import type { ApplicationSettings } from '@ecomgen/contracts';

type Preferences = Pick<ApplicationSettings, 'interfaceScale' | 'taskNotifications'>;
type JobState = { id: string; status: string };
interface Dependencies {
  readSettings(): Promise<Preferences>;
  applyScale(scale: number): void;
  readJob(id: string): Promise<JobState>;
  notificationsSupported(): boolean;
  notify(status: string): void;
}
const terminalStates = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'UNKNOWN']);
/** 原生设置只消费后台真相；查询失败保留现值，绝不写入默认值覆盖用户设置。 */
export class ApplicationPreferences {
  private preferences?: Preferences;
  private refreshing?: Promise<void>;
  private refreshAgain = false;
  private generation = 0;
  private running = new Set<string>();
  private jobQueries = new Map<string, { dirty: boolean; promise: Promise<void> }>();
  public constructor(private readonly dependencies: Dependencies) {}

  public refresh(): Promise<void> {
    this.refreshAgain = true;
    if (!this.refreshing) {
      this.refreshing = (async () => {
        while (this.refreshAgain) {
          this.refreshAgain = false;
          const generation = this.generation;
          try {
            const settings = await this.dependencies.readSettings();
            if (generation !== this.generation) continue;
            if (!Number.isFinite(settings.interfaceScale) || settings.interfaceScale < 0.8 || settings.interfaceScale > 1.3 || typeof settings.taskNotifications !== 'boolean') continue;
            if (settings.taskNotifications !== this.preferences?.taskNotifications) this.disconnected();
            this.preferences = { interfaceScale: settings.interfaceScale, taskNotifications: settings.taskNotifications };
            this.applyCurrentScale();
          } catch { /* 缺失媒体或后台重启时，不推断用户把设置重置为默认值。 */ }
        }
      })().finally(() => { this.refreshing = undefined; });
    }
    return this.refreshing;
  }

  /** document 加载后再次应用，覆盖 Electron session 可能恢复的旧 zoom。 */
  public applyCurrentScale(): void {
    if (this.preferences) this.dependencies.applyScale(this.preferences.interfaceScale);
  }

  /** 断线前的异步查询不得在重连后制造跨进程终态通知。 */
  public disconnected(): void {
    this.generation++;
    this.running.clear();
    this.jobQueries.clear();
  }

  /** 只观察事件指定的任务，不扫描并通知历史终态任务。 */
  public observeJob(id: string): Promise<void> {
    if (!this.preferences?.taskNotifications || !this.dependencies.notificationsSupported()) return Promise.resolve();
    const pending = this.jobQueries.get(id);
    if (pending) { pending.dirty = true; return pending.promise; }
    const generation = this.generation;
    const query = { dirty: true, promise: Promise.resolve() };
    query.promise = Promise.resolve().then(async () => {
      try {
        // 进度事件只标记一次复查；复查期间的新终态事件仍会触发下一次读取。
        while (query.dirty && generation === this.generation) {
          query.dirty = false;
          try {
            const job = await this.dependencies.readJob(id);
            if (generation !== this.generation || !this.preferences?.taskNotifications || job.id !== id) continue;
            if (job.status === 'RUNNING') { this.running.add(id); continue; }
            // 先消费本次运行，OS 拒绝通知也不因终态重放而循环弹出；新 RUNNING 可重新布防。
            const wasRunning = this.running.delete(id);
            if (wasRunning && terminalStates.has(job.status) && this.dependencies.notificationsSupported()) {
              this.dependencies.notify(job.status);
            }
          } catch { /* 原生提醒不可影响任务提交、查询或后续回执。 */ }
        }
      } finally {
        if (this.jobQueries.get(id) === query) this.jobQueries.delete(id);
      }
    });
    this.jobQueries.set(id, query);
    return query.promise;
  }
}
