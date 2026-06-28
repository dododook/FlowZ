/**
 * 协议下拉选项 drift 护栏（一致性 review H4 follow-up / R1 Nit）。
 *
 * PROTOCOL_OPTIONS 是手抄数组（13 项，tailscale 抽到组网 tab），新增协议时需人肉记得来加一行。
 * 补护栏：断言 PROTOCOL_OPTIONS 的 value 集合 ⊆ ALL_PROTOCOLS（TS 不强校验数组完备性，运行时断言兜底），
 * 防止未来 Protocol 新增成员后 PROTOCOL_OPTIONS 漏更新（UI 缺新协议入口）。
 */
import { PROTOCOL_OPTIONS } from '../protocol-options';
import { ALL_PROTOCOLS } from '../../../../../shared/server-completeness';

describe('PROTOCOL_OPTIONS drift 护栏（R1 Nit）', () => {
  it('PROTOCOL_OPTIONS 的 value 全部是合法 Protocol 成员（TS 运行时兜底）', () => {
    for (const opt of PROTOCOL_OPTIONS) {
      expect(ALL_PROTOCOLS).toContain(opt.value);
    }
  });

  it('UI 代理协议下拉覆盖了所有非组网协议（tailscale 抽到组网 tab，故排除）', () => {
    const values = PROTOCOL_OPTIONS.map((o) => o.value);
    const expectedProxyProtocols = ALL_PROTOCOLS.filter((p) => p !== 'tailscale');
    for (const p of expectedProxyProtocols) {
      expect(values).toContain(p);
    }
  });
});
