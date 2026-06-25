/**
 * notify-user 桌面通知出口单测。验证：总开关门控 / isSupported 守卫 / 异常静默 / 缺省视为开。
 * electron 在 node 测试环境不可用 → 内联 mock Notification（记录构造与 show 调用）。
 */

const showMock = jest.fn();
const onMock = jest.fn();
const ctorMock = jest.fn();
let supported = true;

jest.mock('electron', () => ({
  Notification: class {
    static isSupported() {
      return supported;
    }
    constructor(opts: { title: string; body: string }) {
      ctorMock(opts);
    }
    on(event: string, cb: () => void) {
      onMock(event, cb);
      return this;
    }
    show() {
      showMock();
    }
  },
}));

import {
  notifyUser,
  setDesktopNotificationsEnabled,
  isDesktopNotificationsEnabled,
} from '../notify-user';

beforeEach(() => {
  showMock.mockClear();
  onMock.mockClear();
  ctorMock.mockClear();
  supported = true;
  setDesktopNotificationsEnabled(true); // 复位模块级开关，避免跨用例污染
});

describe('notifyUser', () => {
  it('默认开 → 弹通知并带入 title/body', () => {
    notifyUser('FlowZ Proxy Error', 'boom');
    expect(ctorMock).toHaveBeenCalledWith({ title: 'FlowZ Proxy Error', body: 'boom' });
    expect(showMock).toHaveBeenCalledTimes(1);
  });

  it('总开关关 → 不弹', () => {
    setDesktopNotificationsEnabled(false);
    notifyUser('t', 'b');
    expect(ctorMock).not.toHaveBeenCalled();
    expect(showMock).not.toHaveBeenCalled();
  });

  it('系统不支持 → 守卫，不弹不抛', () => {
    supported = false;
    expect(() => notifyUser('t', 'b')).not.toThrow();
    expect(ctorMock).not.toHaveBeenCalled();
    expect(showMock).not.toHaveBeenCalled();
  });

  it('提供 onClick → 注册 click 监听', () => {
    const cb = jest.fn();
    notifyUser('t', 'b', cb);
    expect(onMock).toHaveBeenCalledWith('click', cb);
  });

  it('未提供 onClick → 不注册监听', () => {
    notifyUser('t', 'b');
    expect(onMock).not.toHaveBeenCalled();
  });

  it('构造/show 抛异常 → 静默吞掉，不外抛', () => {
    showMock.mockImplementationOnce(() => {
      throw new Error('platform failure');
    });
    expect(() => notifyUser('t', 'b')).not.toThrow();
  });
});

describe('setDesktopNotificationsEnabled', () => {
  it('undefined（缺省）视为开', () => {
    setDesktopNotificationsEnabled(undefined);
    expect(isDesktopNotificationsEnabled()).toBe(true);
  });

  it('false → 关；true → 开', () => {
    setDesktopNotificationsEnabled(false);
    expect(isDesktopNotificationsEnabled()).toBe(false);
    setDesktopNotificationsEnabled(true);
    expect(isDesktopNotificationsEnabled()).toBe(true);
  });
});
