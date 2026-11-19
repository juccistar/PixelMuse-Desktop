import { LocalAssetStore } from '@ecomgen/core';

/** 在 core 原有路径边界之前检查活动工作空间身份，避免设备失联后重建空目录。 */
export class WorkspaceAssetStore extends LocalAssetStore {
  constructor(root: string, private readonly assertRoot: () => void) { super(root); }
  override async initialize(): Promise<void> { this.assertRoot(); await super.initialize(); }
  override absolute(relativePath: string): string { this.assertRoot(); return super.absolute(relativePath); }
}
