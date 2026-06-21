/**
 * dashboard #55：面板「实际 serve 目录」解析的纯逻辑单测。
 * 决策矩阵：运行时下载覆盖目录（含 index.html）优先 → 否则随包内置目录（含 index.html）→ 两者皆无返回 null
 * （调用方据此不注入 dashboard.path，由 sing-box 联网下载兜底）。仅探 index.html 存在性，无副作用。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ResourceManager } from '../ResourceManager';

function mkUiDir(base: string, name: string, withIndex: boolean): string {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  if (withIndex) fs.writeFileSync(path.join(dir, 'index.html'), '<html></html>');
  return dir;
}

describe('ResourceManager.resolveDashboardServeDir', () => {
  let tmp: string;
  let rm: ResourceManager;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-dash-test-'));
    rm = new ResourceManager();
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('运行时下载覆盖目录有效（含 index.html）→ 优先返回覆盖目录', () => {
    const bundled = mkUiDir(tmp, 'bundled', true);
    const override = mkUiDir(tmp, 'override', true);
    jest.spyOn(rm, 'getBundledDashboardDir').mockReturnValue(bundled);
    expect(rm.resolveDashboardServeDir(override)).toBe(override);
  });

  it('覆盖目录缺失/无 index.html → 回落随包内置目录', () => {
    const bundled = mkUiDir(tmp, 'bundled', true);
    const override = mkUiDir(tmp, 'override-empty', false); // 目录存在但无 index.html
    jest.spyOn(rm, 'getBundledDashboardDir').mockReturnValue(bundled);
    expect(rm.resolveDashboardServeDir(override)).toBe(bundled);
    // 覆盖目录根本不存在时同样回落内置
    expect(rm.resolveDashboardServeDir(path.join(tmp, 'nope'))).toBe(bundled);
  });

  it('覆盖与内置皆无 index.html → 返回 null（调用方走联网下载兜底）', () => {
    const bundled = mkUiDir(tmp, 'bundled-empty', false);
    jest.spyOn(rm, 'getBundledDashboardDir').mockReturnValue(bundled);
    expect(rm.resolveDashboardServeDir(path.join(tmp, 'nope'))).toBeNull();
  });

  it('hasBundledDashboard 反映内置 index.html 存在性', () => {
    const bundled = mkUiDir(tmp, 'b', true);
    jest.spyOn(rm, 'getBundledDashboardDir').mockReturnValue(bundled);
    expect(rm.hasBundledDashboard()).toBe(true);
    jest.spyOn(rm, 'getBundledDashboardDir').mockReturnValue(path.join(tmp, 'missing'));
    expect(rm.hasBundledDashboard()).toBe(false);
  });
});
