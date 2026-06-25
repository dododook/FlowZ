/**
 * 主进程 i18n（桌面通知等文案）单测：语言切换 / 回退 / 5 语 parity / 缺键兜底。
 * electron 在 node 测试环境不可用 → 内联 mock（i18n.ts 间接经 shared/language 不碰 electron，但保险 mock）。
 */
jest.mock('electron', () => ({ app: {} }));

import { SUPPORTED_LANGUAGES, DEFAULT_LANGUAGE } from '../../shared/language';
import { mt, setMainLanguage, getMainLanguage, MAIN_MESSAGE_KEYS } from '../i18n';

// 自动覆盖全部文案键（通知 + 托盘 + 对话框 + 未来新增），无需手维护清单。
const KEYS = MAIN_MESSAGE_KEYS;

afterEach(() => setMainLanguage(DEFAULT_LANGUAGE)); // 复位模块级语言

describe('setMainLanguage / getMainLanguage', () => {
  it('受支持码原样生效', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      setMainLanguage(lang);
      expect(getMainLanguage()).toBe(lang);
    }
  });

  it('auto / 非法 / null → 回退默认语言', () => {
    for (const bad of ['auto', 'xx-YY', '', null, undefined]) {
      setMainLanguage(bad);
      expect(getMainLanguage()).toBe(DEFAULT_LANGUAGE);
    }
  });

  it('fa-IR 旧码迁移成 fa', () => {
    setMainLanguage('fa-IR');
    expect(getMainLanguage()).toBe('fa');
  });
});

describe('mt', () => {
  it('按当前语言返对应文案，且任一键任一语言都非空', () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      setMainLanguage(lang);
      for (const key of KEYS) {
        const v = mt(key);
        expect(typeof v).toBe('string');
        expect(v.length).toBeGreaterThan(0);
      }
    }
  });

  it('不同语言文案确有区分（非全部回落英文）', () => {
    setMainLanguage('zh-CN');
    const zh = mt('proxyErrorBody');
    setMainLanguage('ru');
    const ru = mt('proxyErrorBody');
    setMainLanguage('fa');
    const fa = mt('proxyErrorBody');
    expect(new Set([zh, ru, fa]).size).toBe(3);
  });

  it('5 语 parity：每个键在每个受支持语言都有非空文案', () => {
    // 经 mt 遍历间接断言 MESSAGES 无缺键（Record 类型已编译期保证，运行期再核非空）
    for (const key of KEYS) {
      for (const lang of SUPPORTED_LANGUAGES) {
        setMainLanguage(lang);
        expect(mt(key).trim().length).toBeGreaterThan(0);
      }
    }
  });
});
