/**
 * unlockOnProxyChange 纯谓词单测（node env，无渲染）：代理连接态跃迁 → 检测动作。
 */
import { unlockOnProxyChange } from '../unlock-staleness';

describe('unlockOnProxyChange', () => {
  it('false→true（刚连上）→ detect', () => {
    expect(unlockOnProxyChange(false, true)).toBe('detect');
  });
  it('true→false（断开）→ reset', () => {
    expect(unlockOnProxyChange(true, false)).toBe('reset');
  });
  it('true→true（无变化）→ none', () => {
    expect(unlockOnProxyChange(true, true)).toBe('none');
  });
  it('false→false（一直未连）→ none（初检交挂载路径）', () => {
    expect(unlockOnProxyChange(false, false)).toBe('none');
  });
});
