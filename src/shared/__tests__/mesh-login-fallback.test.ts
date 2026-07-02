/**
 * meshLoginFallbackShouldEngage 纯谓词单测（缺陷1 登录期出口让位判定）。
 * 覆盖：全条件满足→true；每个否决条件（关闭/direct 模式/已回退直连/非 TS/有 authKey/隧道已就绪）单独→false。
 */
import { meshLoginFallbackShouldEngage } from '../mesh-login-fallback';
import type { MeshLoginFallbackInput } from '../mesh-login-fallback';

/** 基线：选中未就绪的全隧道 TS 出口、开关开、非 direct 模式 → 应让位。 */
function base(over: Partial<MeshLoginFallbackInput> = {}): MeshLoginFallbackInput {
  return {
    fallbackEnabled: true,
    proxyModeDirect: false,
    selectedExitFallsBackDirect: false,
    selectedIsTailscale: true,
    selectedHasAuthKey: false,
    selectedTunnelReady: false,
    ...over,
  };
}

describe('meshLoginFallbackShouldEngage', () => {
  it('全条件满足（选中未就绪 TS 出口 + 开关开 + 非 direct）→ true', () => {
    expect(meshLoginFallbackShouldEngage(base())).toBe(true);
  });

  it('开关关闭（fallbackEnabled=false）→ false', () => {
    expect(meshLoginFallbackShouldEngage(base({ fallbackEnabled: false }))).toBe(false);
  });

  it('direct 代理模式 → false（默认本就 direct，无「→代理」出口）', () => {
    expect(meshLoginFallbackShouldEngage(base({ proxyModeDirect: true }))).toBe(false);
  });

  it('选中出口已回退直连（off-mesh / 仅子网段）→ false（final 已 direct，无死锁）', () => {
    expect(meshLoginFallbackShouldEngage(base({ selectedExitFallsBackDirect: true }))).toBe(false);
  });

  it('选中出口非 Tailscale → false（无账号制交互登录死锁）', () => {
    expect(meshLoginFallbackShouldEngage(base({ selectedIsTailscale: false }))).toBe(false);
  });

  it('TS 配了 authKey（静态凭据，无交互登录）→ false', () => {
    expect(meshLoginFallbackShouldEngage(base({ selectedHasAuthKey: true }))).toBe(false);
  });

  it('隧道已就绪（Running）→ false（出口已可用，正常经代理）', () => {
    expect(meshLoginFallbackShouldEngage(base({ selectedTunnelReady: true }))).toBe(false);
  });
});
