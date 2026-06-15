/**
 * applyRuleSetPrune 单测（纯逻辑、无 I/O）：远程 geo rule_set 404 时的剪枝语义。
 *
 * 背景：sing-box 对任一 remote rule_set 取回 404 会**整体 FATAL**（崩整个代理，非跳过）。预检发现确定缺失的
 * rule_set 后，applyRuleSetPrune 把它从定义与路由引用中剔除，rule_set 清空的规则整条丢弃（"资源不存在则该规则停止"）。
 *
 * 私有方法经 `(svc as any).applyRuleSetPrune()` 直调（跟随既有 proxy-manager 测试风格），不触网、不启动 sing-box。
 */
import { ProxyManager } from '../ProxyManager';

function makeSvc(): any {
  return new ProxyManager(
    undefined as any,
    undefined as any,
    '/tmp/flowz-test-cfg.json',
    '/fake/sing-box'
  );
}

/** 构造一份含「应用分流 Telegram」典型路由的最小 singbox 配置。 */
function makeConfig(): any {
  return {
    outbounds: [],
    route: {
      rule_set: [
        {
          tag: 'geosite-telegram',
          type: 'remote',
          format: 'binary',
          url: 'https://x/geosite/telegram.srs',
        },
        {
          tag: 'geoip-telegram',
          type: 'remote',
          format: 'binary',
          url: 'https://x/geoip/telegram.srs',
        },
        // 本地 bundled（非 remote）——永不入 unreachable，应始终保留
        { tag: 'geoip-cn', type: 'local', format: 'binary', path: '/bundled/geoip-cn.srs' },
      ],
      rules: [
        // 进程名规则（无 rule_set）——应始终不受影响
        { process_name: ['Telegram.exe'], action: 'route', outbound: 'rule-sel-app-telegram' },
        // rule_set 规则（geosite+geoip）
        {
          rule_set: ['geosite-telegram', 'geoip-telegram'],
          action: 'route',
          outbound: 'rule-sel-app-telegram',
        },
        // 配对的 udp443 reject（含 rule_set + 端口/网络）
        {
          rule_set: ['geosite-telegram', 'geoip-telegram'],
          network: ['udp'],
          port: [443],
          action: 'reject',
        },
        // 全局规则（string rule_set，本地）——不受影响
        { rule_set: 'geoip-cn', action: 'route', outbound: 'direct' },
      ],
    },
  };
}

describe('ProxyManager.applyRuleSetPrune（远程 rule_set 404 剪枝）', () => {
  const svc = makeSvc();

  it('部分缺失（geoip 404、geosite 存在）：剔 geoip-telegram，规则保留 geosite-telegram', () => {
    const cfg = makeConfig();
    const dropped = svc.applyRuleSetPrune(cfg, new Set(['geoip-telegram']));
    expect(dropped).toEqual(['geoip-telegram']);
    // 定义只剩 geosite-telegram + geoip-cn
    expect(cfg.route.rule_set.map((r: any) => r.tag)).toEqual(['geosite-telegram', 'geoip-cn']);
    // 进程名规则不动
    expect(cfg.route.rules[0]).toMatchObject({ process_name: ['Telegram.exe'] });
    // rule_set 规则保留 geosite-telegram（geoip 被剔）
    const rsRule = cfg.route.rules.find(
      (r: any) => r.outbound === 'rule-sel-app-telegram' && r.rule_set
    );
    expect(rsRule.rule_set).toEqual(['geosite-telegram']);
    // udp443 reject 也保留 geosite-telegram
    const reject = cfg.route.rules.find((r: any) => r.action === 'reject');
    expect(reject.rule_set).toEqual(['geosite-telegram']);
    // 本地 string rule_set 规则不动
    expect(cfg.route.rules.find((r: any) => r.rule_set === 'geoip-cn')).toBeTruthy();
  });

  it('全部缺失（geosite+geoip 均 404）：rule_set 规则整条丢弃，进程名规则仍在', () => {
    const cfg = makeConfig();
    const dropped = svc.applyRuleSetPrune(cfg, new Set(['geosite-telegram', 'geoip-telegram']));
    expect(dropped.sort()).toEqual(['geoip-telegram', 'geosite-telegram']);
    // 两个远程定义都删，只剩本地 geoip-cn
    expect(cfg.route.rule_set.map((r: any) => r.tag)).toEqual(['geoip-cn']);
    // rule_set 规则（route + reject）都被丢；进程名规则与本地 string 规则保留
    expect(cfg.route.rules.some((r: any) => Array.isArray(r.rule_set))).toBe(false);
    expect(cfg.route.rules.find((r: any) => r.process_name)).toBeTruthy();
    expect(cfg.route.rules.find((r: any) => r.rule_set === 'geoip-cn')).toBeTruthy();
  });

  it('空 unreachable：配置零改动', () => {
    const cfg = makeConfig();
    const before = JSON.stringify(cfg);
    const dropped = svc.applyRuleSetPrune(cfg, new Set<string>());
    expect(dropped).toEqual([]);
    expect(JSON.stringify(cfg)).toBe(before);
  });

  it('悬空 tag（无 rule_set 定义，fail-closed 本地 geo 缺失）：仍剪掉引用它的规则', () => {
    // fail-closed 基石：本地 geo 缺失时不注入 rule_set 定义，但引用它的路由规则尚在 → 悬空引用。
    // applyRuleSetPrune 以 unreachable.size（而非 dropped.length）为闸，故无定义可删时仍能剪规则，杜绝 sing-box FATAL。
    const cfg: any = {
      outbounds: [],
      route: {
        rule_set: [{ tag: 'geoip-cn', type: 'local', format: 'binary', path: '/b/geoip-cn.srs' }],
        rules: [
          { process_name: ['App.exe'], action: 'route', outbound: 'rule-sel-app-x' },
          { rule_set: ['geosite-amazon'], action: 'route', outbound: 'rule-sel-app-x' },
          { rule_set: 'geoip-cn', action: 'route', outbound: 'direct' },
        ],
      },
    };
    const dropped = svc.applyRuleSetPrune(cfg, new Set(['geosite-amazon']));
    expect(dropped).toEqual([]); // 无定义可删 → dropped 空（关键：剪规则不以 dropped 为闸）
    expect(cfg.route.rules.some((r: any) => Array.isArray(r.rule_set))).toBe(false); // 悬空引用规则被剪
    expect(cfg.route.rules.find((r: any) => r.process_name)).toBeTruthy(); // 进程名规则保留
    expect(cfg.route.rules.find((r: any) => r.rule_set === 'geoip-cn')).toBeTruthy(); // 本地规则保留
    expect(cfg.route.rule_set.map((r: any) => r.tag)).toEqual(['geoip-cn']); // 定义不动
  });

  it('logical 规则：子条件 rule_set 全缺失 → 整条 logical 丢弃', () => {
    const cfg: any = {
      outbounds: [],
      route: {
        rule_set: [
          { tag: 'geosite-foo', type: 'remote', format: 'binary', url: 'https://x/foo.srs' },
        ],
        rules: [
          {
            type: 'logical',
            mode: 'or',
            rules: [{ rule_set: ['geosite-foo'] }],
            action: 'route',
            outbound: 'proxy-selector',
          },
        ],
      },
    };
    const dropped = svc.applyRuleSetPrune(cfg, new Set(['geosite-foo']));
    expect(dropped).toEqual(['geosite-foo']);
    expect(cfg.route.rules).toEqual([]); // logical 子条件清空 → 整条丢
  });

  it('嵌套 AND udp443 reject：内层 geo logical 被剪空 → 整条 AND 丢，不坍缩成无差别全局 reject', () => {
    // 复现 blockQuic + 全 geo 缺失的 OR logical 自定义代理规则派生的配对 reject 结构（generateRouteConfig）：
    // 外层 AND = [内层 geo logical, {udp443}]；内层 geo 缺失被剪空 → 外层不可坍缩成裸 {udp443}（否则误 reject 所有 QUIC）。
    const cfg: any = {
      outbounds: [],
      route: {
        rule_set: [],
        rules: [
          {
            action: 'reject',
            type: 'logical',
            mode: 'and',
            rules: [
              { type: 'logical', mode: 'or', rules: [{ rule_set: ['geosite-amazon'] }] },
              { network: ['udp'], port: [443] },
            ],
          },
        ],
      },
    };
    svc.applyRuleSetPrune(cfg, new Set(['geosite-amazon']));
    // 整条 AND 被丢，绝不残留 {action:'reject', rules:[{network:['udp'],port:[443]}]}
    expect(cfg.route.rules).toEqual([]);
  });
});
