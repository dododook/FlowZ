/**
 * 更新弹窗状态机的可 mock 单测：并发流互斥闸门 + 下载错误本地化映射。
 * （弹窗创建/定位/焦点/IPC 收发属 runtime 项，由真机 + Xvfb harness 验；此处只钉纯逻辑分支。）
 */
import * as os from 'os';
import * as path from 'path';
import * as fsSync from 'fs';

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-updsvc-test-'));

jest.mock('electron', () => ({
  app: { getPath: () => TMP, getVersion: () => '1.0.0', isPackaged: false, getAppPath: () => TMP },
  shell: {},
  BrowserWindow: class {},
  dialog: { showMessageBox: jest.fn() },
  net: {},
  session: {},
  Notification: class {},
}));

import { UpdateService } from '../UpdateService';
import { setMainLanguage, mt } from '../../i18n';

const log = { addLog: () => {} } as any;

describe('UpdateService.showUpdateDialog 并发流互斥闸门', () => {
  it('已有活跃弹窗 → 直接返回 later，不新建弹窗（Med-1：防覆盖 resolver / 双下载）', async () => {
    const svc = new UpdateService(log) as any;
    svc.updatePopupWindow = { isDestroyed: () => false }; // 模拟弹窗流进行中
    await expect(svc.showUpdateDialog({ version: 'v2.0.0', releaseNotes: '' })).resolves.toBe(
      'later'
    );
    // 断言未触碰弹窗创建（updatePopupWindow 仍是注入的假窗，未被替换）
    expect(typeof svc.updatePopupWindow.isDestroyed).toBe('function');
  });
});

describe('UpdateService.localizeDownloadError 错误本地化映射（Low-5）', () => {
  const svc = new UpdateService(log) as any;
  beforeAll(() => setMainLanguage('en-US'));

  it('网络/超时类 → updErrNetwork', () => {
    expect(svc.localizeDownloadError('下载停滞超时（30s 无数据，网络中断或被拦截）')).toBe(
      mt('updErrNetwork')
    );
    expect(svc.localizeDownloadError('ETIMEDOUT')).toBe(mt('updErrNetwork'));
    expect(svc.localizeDownloadError('net::ERR_INTERNET_DISCONNECTED')).toBe(mt('updErrNetwork'));
  });

  it('不完整/截断 → updErrIncomplete', () => {
    expect(svc.localizeDownloadError('下载不完整：收到 1 字节，期望 100（可能被截断）')).toBe(
      mt('updErrIncomplete')
    );
  });

  it('HTTP/服务器错误 → updErrServer', () => {
    expect(svc.localizeDownloadError('下载失败: HTTP 404')).toBe(mt('updErrServer'));
    expect(svc.localizeDownloadError('GitHub API 访问频率限制 (403)')).toBe(mt('updErrServer'));
  });

  it('未知错误 → updErrGeneric 兜底', () => {
    expect(svc.localizeDownloadError('莫名其妙的错误')).toBe(mt('updErrGeneric'));
  });

  it('映射结果随当前语言变化（本地化生效）', () => {
    setMainLanguage('zh-CN');
    expect(svc.localizeDownloadError('ETIMEDOUT')).toBe(mt('updErrNetwork'));
    expect(mt('updErrNetwork')).toContain('网络');
    setMainLanguage('en-US');
  });
});
