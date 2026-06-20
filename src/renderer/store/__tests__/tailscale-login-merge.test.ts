/**
 * mergeTailscaleLoginStates 单测（#86-122 复审硬化 #5：登录态整表刷新防覆盖乐观点亮）。
 *
 * 核心不变量：在途 refresh（捕获 genAtStart）期间「新点亮 true」的节点（登记 gen > genAtStart）
 * 不被磁盘尚未落地的 falsy 整表覆盖打回；而登出 / 旧点亮 / 磁盘已为 true 等场景，磁盘真值正常生效。
 */
import { mergeTailscaleLoginStates } from '../tailscale-login-merge';

describe('mergeTailscaleLoginStates（登录态防覆盖）', () => {
  it('在途 refresh 期间新点亮 true（gen>genAtStart）+ 磁盘 falsy → 保留乐观 true（丢弃过期覆盖）', () => {
    const genAtStart = 5;
    const disk = { s1: false }; // 磁盘快照仍登录前
    const current = { s1: true }; // 内存已乐观点亮
    const optimistic = new Map([['s1', 6]]); // 6 > 5：refresh 发起之后点亮
    expect(mergeTailscaleLoginStates(disk, current, optimistic, genAtStart)).toEqual({ s1: true });
  });

  it('点亮发生在 refresh 发起之前（gen<=genAtStart）→ 磁盘 false 正常覆盖（不保护旧点亮）', () => {
    const genAtStart = 5;
    const disk = { s1: false };
    const current = { s1: true };
    const optimistic = new Map([['s1', 5]]); // 5 == genAtStart：非「之后」点亮
    expect(mergeTailscaleLoginStates(disk, current, optimistic, genAtStart)).toEqual({ s1: false });
  });

  it('磁盘已为 true → 直接采纳磁盘（无需保护，merged[s1] 已 true）', () => {
    const disk = { s1: true };
    const current = { s1: true };
    const optimistic = new Map([['s1', 6]]);
    expect(mergeTailscaleLoginStates(disk, current, optimistic, 5)).toEqual({ s1: true });
  });

  it('登出：内存已 false（无乐观登记）→ 磁盘 false 生效，不误保护', () => {
    const disk = { s1: false };
    const current = { s1: false }; // setTailscaleLoginState(false) 已撤销登记并置 false
    const optimistic = new Map<string, number>(); // 登出已 delete 登记
    expect(mergeTailscaleLoginStates(disk, current, optimistic, 5)).toEqual({ s1: false });
  });

  it('新点亮但内存当前为 falsy（current 无该值）→ 不保护（防凭空造 true）', () => {
    const genAtStart = 5;
    const disk = { s1: false };
    const current: Record<string, boolean> = {}; // 内存里没有 s1=true
    const optimistic = new Map([['s1', 6]]);
    expect(mergeTailscaleLoginStates(disk, current, optimistic, genAtStart)).toEqual({ s1: false });
  });

  it('磁盘新增其它节点 + 在途新点亮节点：两者各自处理（互不干扰）', () => {
    const genAtStart = 10;
    const disk = { s1: false, s2: true }; // s2 磁盘已登录
    const current = { s1: true }; // s1 乐观点亮
    const optimistic = new Map([['s1', 11]]); // s1 在途新点亮
    expect(mergeTailscaleLoginStates(disk, current, optimistic, genAtStart)).toEqual({
      s1: true, // 保护
      s2: true, // 磁盘真值
    });
  });

  it('不修改入参（返回新对象）', () => {
    const disk = { s1: false };
    const current = { s1: true };
    const optimistic = new Map([['s1', 6]]);
    const out = mergeTailscaleLoginStates(disk, current, optimistic, 5);
    expect(disk).toEqual({ s1: false }); // 原磁盘表不变
    expect(out).not.toBe(disk);
  });
});
