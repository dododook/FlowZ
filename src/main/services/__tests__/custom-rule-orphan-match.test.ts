/**
 * isCustomRuleOrphanFile（外化规则孤儿文件判定）单测。
 * 回归：曾因正则强制 .tmp$ 丢了裸 custom-rule-*.json（孤儿主目标），致删规则/改 id/转 inline 后
 * .json 孤儿文件永久残留磁盘。本测试钉死「裸 .json + 任意 .tmp 变体」都命中、非目标不误删。
 */
import * as os from 'os';
import * as fsSync from 'fs';
import * as path from 'path';

const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'flowz-orphan-'));
jest.mock('electron', () => ({
  app: { getPath: () => TMP, getVersion: () => '9.9.9', isPackaged: false, getAppPath: () => TMP },
  BrowserWindow: class {},
  Notification: class {},
  net: {},
  session: {},
}));

import { isCustomRuleOrphanFile } from '../ProxyManager';

describe('isCustomRuleOrphanFile（裸 .json + .tmp 变体）', () => {
  it.each([
    'custom-rule-abc.json', // 裸 .json —— 孤儿主目标（回归点）
    'custom-rule-x_y.z@1.json', // id 含特殊字符
    'custom-rule-abc.json.tmp', // 裸 .tmp 残留
    'custom-rule-abc.json.4321.abcdef.tmp', // writeFileAtomic 唯一后缀 .<pid>.<rand>.tmp
  ])('命中孤儿: %s', (name) => {
    expect(isCustomRuleOrphanFile(name)).toBe(true);
  });

  it.each([
    'custom-rule-abc.txt', // 非 .json
    'other.json', // 非 custom-rule- 前缀
    'app.log',
    'custom-rule-abc.json.bak', // .json 后非 .tmp 结尾
  ])('不误删: %s', (name) => {
    expect(isCustomRuleOrphanFile(name)).toBe(false);
  });
});
