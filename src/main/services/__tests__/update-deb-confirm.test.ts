/**
 * deb 更新的「一次授权说明」确认框（UpdateService）。
 *
 * deb 装 /opt 需 root，后续 pkexec 弹 polkit 通用框（文案改不了）→ installUpdate 顶部先弹 app 内说明框。
 * 验：① isDebUpdateForm 门控（仅 linux + 非 AppImage 运行 + .deb 资产才弹）；② confirmDebElevation 映射
 * response→bool；③ **取消 = 真 no-op**（弹框在 cleanupCallback 停代理之前，取消时代理未停）。纯逻辑 + 三平台 mock。
 */
import * as os from 'os';
import * as path from 'path';
import * as fsSync from 'fs';

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-deb-confirm-'));

jest.mock('electron', () => ({
  app: {
    getPath: () => TMP,
    getVersion: () => '9.9.9',
    isPackaged: false,
    getAppPath: () => TMP,
    exit: jest.fn(),
  },
  shell: { openPath: jest.fn() },
  dialog: { showMessageBox: jest.fn() },
  BrowserWindow: class {},
  net: {},
}));

import { UpdateService } from '../UpdateService';
import { setPlatform, REAL_PLATFORM } from './platform-test-utils';
const { dialog } = require('electron');

const log = { addLog: () => {} } as any;
const ORIG_APPIMAGE = process.env.APPIMAGE;

const isDebForm = (svc: UpdateService, p: string): boolean =>
  (svc as unknown as { isDebUpdateForm: (p: string) => boolean }).isDebUpdateForm(p);
const confirmDeb = (svc: UpdateService): Promise<boolean> =>
  (svc as unknown as { confirmDebElevation: () => Promise<boolean> }).confirmDebElevation();

beforeEach(() => {
  (dialog.showMessageBox as jest.Mock).mockReset();
  setPlatform('linux');
  delete process.env.APPIMAGE;
});

afterAll(() => {
  setPlatform(REAL_PLATFORM);
  if (ORIG_APPIMAGE === undefined) delete process.env.APPIMAGE;
  else process.env.APPIMAGE = ORIG_APPIMAGE;
  try {
    fsSync.rmSync(TMP, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('UpdateService deb 更新一次授权说明框', () => {
  describe('isDebUpdateForm 门控（仅 linux + 非 AppImage 运行 + .deb 资产）', () => {
    it('linux + .deb + 无 APPIMAGE → true', () => {
      expect(isDebForm(new UpdateService(log), '/x/FlowZ.deb')).toBe(true);
    });
    it('linux + .AppImage → false', () => {
      expect(isDebForm(new UpdateService(log), '/x/FlowZ.AppImage')).toBe(false);
    });
    it('linux + .deb 但 APPIMAGE 运行态 → false（跨形态守卫，杜绝 AppImage 用户被 system-wide 装 deb）', () => {
      process.env.APPIMAGE = '/run/FlowZ.AppImage';
      expect(isDebForm(new UpdateService(log), '/x/FlowZ.deb')).toBe(false);
    });
    it('win32 + .deb → false（Linux 专属）', () => {
      setPlatform('win32');
      expect(isDebForm(new UpdateService(log), '/x/FlowZ.deb')).toBe(false);
    });
  });

  describe('confirmDebElevation 映射', () => {
    it('response=0 → true（继续）', async () => {
      (dialog.showMessageBox as jest.Mock).mockResolvedValue({ response: 0 });
      await expect(confirmDeb(new UpdateService(log))).resolves.toBe(true);
    });
    it('response=1 → false（取消）', async () => {
      (dialog.showMessageBox as jest.Mock).mockResolvedValue({ response: 1 });
      await expect(confirmDeb(new UpdateService(log))).resolves.toBe(false);
    });
  });

  describe('installUpdate deb 取消 = 真 no-op（弹框在停代理之前）', () => {
    it('deb + 取消 → 返回 false、弹框一次、cleanupCallback 零调用（代理未停）', async () => {
      const deb = path.join(TMP, 'FlowZ-x.deb');
      fsSync.writeFileSync(deb, 'dummy');
      (dialog.showMessageBox as jest.Mock).mockResolvedValue({ response: 1 });
      const svc = new UpdateService(log);
      const cleanup = jest.fn(async () => {});
      svc.setCleanupCallback(cleanup);

      const ret = await svc.installUpdate(deb);

      expect(ret).toBe(false);
      expect(dialog.showMessageBox).toHaveBeenCalledTimes(1);
      expect(cleanup).not.toHaveBeenCalled(); // 停代理在确认框之后 → 取消不停代理，真 no-op
    });
  });
});
