import { useState, useEffect, useRef, useMemo } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useAppStore } from '@/store/app-store';
import { parseDnsServerSpec, DNS_TIMEOUT_MIN_MS, DNS_TIMEOUT_MAX_MS } from '@shared/dns';
import {
  BUILTIN_UPSTREAMS,
  isValidCustomUpstreamSpec,
  parseCustomUpstream,
  upstreamCanonicalKey,
  MAX_TIER1_UPSTREAMS,
  DEFAULT_POOL_IDS,
  DEFAULT_SINGLE_ID,
} from '@shared/node-resolver-upstreams';
import type { CustomDnsUpstream, DnsConfig, TunStack } from '@shared/types';
import { DEFAULT_BYPASS_LAN } from '@shared/system-proxy-bypass';
import { DEFAULT_BROWSER_DOH_KEYWORDS } from '@shared/browser-doh';
import { parseSpeedTestUrl, DEFAULT_SPEED_TEST_URL } from '@shared/speed-test';
import {
  resolveTunStack,
  resolveTunMtu,
  parseTunMtuInput,
  isDegradedMtuCombo,
  CONCRETE_TUN_STACKS,
  TUN_MTU_MIN,
  TUN_MTU_MAX,
  TUN_MTU_SAFE_MAX_NON_GVISOR,
} from '@shared/tun-defaults';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { InfoTooltip } from './shared/info-tooltip';
import { ExceptionList } from './exception-list';
import { DEFAULT_FAKEIP_FILTER_DOMAINS } from '../../../shared/fakeip-filter';
import { HelperManagementCard } from './helper-management-card';
import { TerminalProxySection } from './terminal-proxy-section';
import { Srow, Swt, Collapse } from './conduit-controls';

const isMac = window.electron?.platform === 'darwin';
const isWin = window.electron?.platform === 'win32';
// Linux 现在也真接管系统 DNS（经 systemd-resolved 把 TUN 链路设为全域 DNS 出口），故接管开关的说明文案
// 必须分出 Linux 分支——这个开关的授权语义就来自它旁边那段说明，写「不改动系统 DNS」却改了是对用户的违约。
const isLinux = window.electron?.platform === 'linux';

const platform = window.electron?.platform ?? 'linux';
// Auto 档在本平台解析到的具体栈（UI 显示 "Auto (gvisor)" 用），与主进程 resolveTunStack 同源单一真值。
const autoResolvedStack = resolveTunStack('auto', platform);

/**
 * 表单可选的本地端口区间。**下界 1024 是 UI 侧的额外约束，不是 config 的合法区间**——
 * `ConfigManager.validateConfig` 放行 1..65535（要容忍存量低端口配置）。故这里刻意**不**抽成 shared 常量：
 * 抽了会把「表单不让选特权端口」与「配置层可接受」这两件不同的事伪装成同一个真值。
 */
const LOCAL_PORT_MIN = 1024;
const LOCAL_PORT_MAX = 65535;

const DNS_DEFAULTS = {
  domesticDns: 'https://doh.pub/dns-query',
  foreignDns: 'https://dns.google/dns-query',
} as const;

/**
 * 设置「网络」节（Conduit `.set-panel data-set-panel="network"`）：提权助手 + DNS / 端口 / 连接 / 订阅自动更新 / 终端代理。
 * 由原「高级」页拆出（高频网络调整应有一级入口）；并把混在「局域网设置」里的非 LAN 项归位到「连接」。
 */
export function NetworkSettings() {
  const config = useAppStore((state) => state.config);
  const saveConfig = useAppStore((state) => state.saveConfig);
  const { t } = useTranslation();

  // mixed-only：单一本地端口（同口 HTTP+SOCKS）。绑 mixedPort（旧配置回退 httpPort，新装默认 7890）。
  const [localPort, setLocalPort] = useState(
    (config?.mixedPort || config?.httpPort || 7890).toString()
  );
  // TUN 模式下 FakeIP ON→OFF 一次性风险确认弹窗开关（机场拒纯 IP 不可预判、无法客户端缓解）。
  const [fakeIpOffConfirmOpen, setFakeIpOffConfirmOpen] = useState(false);
  const [subInterval, setSubInterval] = useState(
    config?.subscriptionUpdateIntervalHours?.toString() || '12'
  );
  const [domesticDns, setDomesticDns] = useState(
    config?.dnsConfig?.domesticDns || DNS_DEFAULTS.domesticDns
  );
  const [foreignDns, setForeignDns] = useState(
    config?.dnsConfig?.foreignDns || DNS_DEFAULTS.foreignDns
  );
  const [speedTestUrl, setSpeedTestUrl] = useState(config?.speedTestUrl || DEFAULT_SPEED_TEST_URL);
  // 字段级校验错误内联（红框 + 红字，取代 toast；系统级/保存失败仍走 toast，与 §6 内联口径一致）。
  const [dnsError, setDnsError] = useState<{ domesticDns?: boolean; foreignDns?: boolean }>({});
  const [speedTestUrlError, setSpeedTestUrlError] = useState(false);
  // P2c DNS 查询超时（毫秒；空 = 用核默认，不下发）。文本态便于「清空即重置默认」与 onBlur 提交。
  const [dnsTimeout, setDnsTimeout] = useState(
    config?.dnsConfig?.dnsTimeoutMs != null ? String(config.dnsConfig.dnsTimeoutMs) : ''
  );
  // TUN MTU（空 = Auto，存 'auto' 而非具体数字——存的是意图，解析期才落 (平台×栈) 值）。
  const [tunMtu, setTunMtu] = useState(
    typeof config?.tunConfig?.mtu === 'number' ? String(config.tunConfig.mtu) : ''
  );

  // F26：config 异步到达 / 挂载期间被外部替换（托盘改配置、备份恢复、规则 CRUD 后 loadConfig）时，
  // 回填「未被用户改动」的字段；dirty 守卫（本地值 ≠ 上次种子）避免打断正在输入的用户。
  const seededRef = useRef<{
    localPort: string;
    subInterval: string;
    domesticDns: string;
    foreignDns: string;
    speedTestUrl: string;
    dnsTimeout: string;
    tunMtu: string;
  } | null>(null);
  useEffect(() => {
    if (!config) return;
    const snap = {
      localPort: (config.mixedPort || config.httpPort || 7890).toString(),
      subInterval: config.subscriptionUpdateIntervalHours?.toString() || '12',
      domesticDns: config.dnsConfig?.domesticDns || DNS_DEFAULTS.domesticDns,
      foreignDns: config.dnsConfig?.foreignDns || DNS_DEFAULTS.foreignDns,
      speedTestUrl: config.speedTestUrl || DEFAULT_SPEED_TEST_URL,
      dnsTimeout:
        config.dnsConfig?.dnsTimeoutMs != null ? String(config.dnsConfig.dnsTimeoutMs) : '',
      tunMtu: typeof config.tunConfig?.mtu === 'number' ? String(config.tunConfig.mtu) : '',
    };
    const prev = seededRef.current;
    setLocalPort((cur) => (prev && cur !== prev.localPort ? cur : snap.localPort));
    setSubInterval((cur) => (prev && cur !== prev.subInterval ? cur : snap.subInterval));
    setDomesticDns((cur) => (prev && cur !== prev.domesticDns ? cur : snap.domesticDns));
    setForeignDns((cur) => (prev && cur !== prev.foreignDns ? cur : snap.foreignDns));
    setSpeedTestUrl((cur) => (prev && cur !== prev.speedTestUrl ? cur : snap.speedTestUrl));
    setDnsTimeout((cur) => (prev && cur !== prev.dnsTimeout ? cur : snap.dnsTimeout));
    setTunMtu((cur) => (prev && cur !== prev.tunMtu ? cur : snap.tunMtu));
    seededRef.current = snap;
  }, [
    config?.mixedPort,
    config?.httpPort,
    config?.subscriptionUpdateIntervalHours,
    config?.dnsConfig?.domesticDns,
    config?.dnsConfig?.foreignDns,
    config?.speedTestUrl,
    config?.dnsConfig?.dnsTimeoutMs,
    config?.tunConfig?.mtu,
  ]);

  if (!config) return null;

  const isTunMode = config.proxyModeType?.toLowerCase() === 'tun';

  const setBool = (key: keyof typeof config, value: boolean) =>
    saveConfig({ ...config, [key]: value }).catch(() => toast.error(t('common.saveFailed')));

  const updateDns = (patch: Partial<NonNullable<typeof config.dnsConfig>>) => {
    const updated = { ...config };
    if (!updated.dnsConfig) {
      updated.dnsConfig = {
        domesticDns: 'https://doh.pub/dns-query',
        foreignDns: 'https://dns.google/dns-query',
        enableFakeIp: true, // 与新装默认一致（usesFakeIp 已统一为纯看开关）
      };
    }
    updated.dnsConfig = { ...updated.dnsConfig, ...patch };
    saveConfig(updated).catch(() => toast.error(t('common.saveFailed')));
  };

  // 用户手动改 FakeIP 开关：同写 fakeIpTunAutoEnable:false 撤销「待纠正」快照——之后切模式绝不再自动改
  // enableFakeIp（意图即撤销，防误伤 TUN 下主动关 FakeIP 的用户）。三处写入点（toggle / TUN 关闭确认 / IPv6 提示）统一走此。
  const writeFakeIp = (checked: boolean) => {
    updateDns({ enableFakeIp: checked, fakeIpTunAutoEnable: false });
  };

  // P6 局域网网关：更新 tunConfig 子字段（MAC 过滤 / 邻居解析后缀），保留其余 TUN 设置。
  const updateTun = (patch: Partial<NonNullable<typeof config.tunConfig>>) =>
    saveConfig({ ...config, tunConfig: { ...config.tunConfig, ...patch } }).catch(() =>
      toast.error(t('common.saveFailed'))
    );

  // FakeIP 开关切换：TUN 模式下 ON→OFF 先弹一次性风险确认（节点将收真实 IP，部分机场可能拒连，客户端无法缓解）；
  // 其它情况（开启、或非 TUN 关闭）直接落盘。
  const handleFakeIpToggle = (checked: boolean) => {
    if (!checked && isTunMode) {
      setFakeIpOffConfirmOpen(true);
      return;
    }
    writeFakeIp(checked);
  };

  // F1：DNS 改为提交时保存（onBlur），而非逐键 saveConfig（代理运行时逐键会触发全量重启 + 受控回显竞态）。
  const commitDns = (key: 'domesticDns' | 'foreignDns', raw: string) => {
    const v = raw.trim();
    if (v && !parseDnsServerSpec(v)) {
      setDnsError((prev) => ({ ...prev, [key]: true })); // 非法值内联标红，不落盘，保留输入待修正
      return;
    }
    setDnsError((prev) => ({ ...prev, [key]: false }));
    const next = v || DNS_DEFAULTS[key]; // 清空即重置为默认
    if (key === 'domesticDns') setDomesticDns(next);
    else setForeignDns(next);
    const stored = config.dnsConfig?.[key] || DNS_DEFAULTS[key];
    if (next === stored) return; // 无变化不保存，避免无谓重启
    updateDns({ [key]: next });
  };

  // 测速端点 URL：提交时保存（onBlur，避免逐键触发）。空值→重置默认；非空须合法 http(s) URL（后端非法亦回落默认）。
  const commitSpeedTestUrl = (raw: string) => {
    const v = raw.trim();
    if (v && !parseSpeedTestUrl(v)) {
      setSpeedTestUrlError(true); // 非法内联标红，保留输入待修正（不回滚，与 DNS/§6 一致）
      return;
    }
    setSpeedTestUrlError(false);
    const next = v || DEFAULT_SPEED_TEST_URL; // 清空即重置默认
    setSpeedTestUrl(next);
    const stored = config.speedTestUrl || DEFAULT_SPEED_TEST_URL;
    if (next === stored) return; // 无变化不保存
    saveConfig({ ...config, speedTestUrl: next }).catch(() => toast.error(t('common.saveFailed')));
  };

  // P2c DNS 查询超时：onBlur 提交。空 = 清除（不下发，用核默认）；非空须在 shared/dns 的区间内，越界提示并回滚。
  const commitDnsTimeout = () => {
    const v = dnsTimeout.trim();
    const stored = config.dnsConfig?.dnsTimeoutMs;
    if (v === '') {
      if (stored == null) return; // 本就未设，无变化
      setDnsTimeout('');
      updateDns({ dnsTimeoutMs: undefined });
      return;
    }
    const ms = parseInt(v, 10);
    if (isNaN(ms) || ms < DNS_TIMEOUT_MIN_MS || ms > DNS_TIMEOUT_MAX_MS) {
      toast.error(
        t('settings.advanced.dnsTimeoutRange', {
          min: DNS_TIMEOUT_MIN_MS,
          max: DNS_TIMEOUT_MAX_MS,
        })
      );
      setDnsTimeout(stored != null ? String(stored) : ''); // 回滚到已存值
      return;
    }
    if (ms === stored) return; // 无变化
    setDnsTimeout(String(ms));
    updateDns({ dnsTimeoutMs: ms });
  };

  // 本地端口：失焦即生效（mixed-only 单口 HTTP+SOCKS，只写 mixedPort）。范围/冲突给提示并回滚，不需保存按钮。
  const commitLocalPort = () => {
    const portNum = parseInt(localPort, 10);
    const cur = config.mixedPort || config.httpPort || 7890;
    const revert = () => setLocalPort(cur.toString());
    if (isNaN(portNum) || portNum < LOCAL_PORT_MIN || portNum > LOCAL_PORT_MAX) {
      toast.error(
        t('settings.advanced.localPortRange', { min: LOCAL_PORT_MIN, max: LOCAL_PORT_MAX })
      );
      revert();
      return;
    }
    if (portNum === cur) return; // 无变化
    setLocalPort(portNum.toString());
    saveConfig({ ...config, mixedPort: portNum }).catch(() => toast.error(t('common.saveFailed')));
  };

  // TUN MTU：失焦即生效。清空 = 复位 Auto（写 'auto'，而非把当前平台值固化成数字——固化会让后续
  // 平台默认演进对该用户失效，正是本次模型统一要消除的问题）。越界给提示并回滚到已存值。
  const commitTunMtu = () => {
    const stored = config.tunConfig?.mtu;
    const next = parseTunMtuInput(tunMtu);
    if (next === null) {
      toast.error(t('settings.advanced.tunMtuRange', { min: TUN_MTU_MIN, max: TUN_MTU_MAX }));
      setTunMtu(typeof stored === 'number' ? String(stored) : ''); // 回滚到已存值
      return;
    }
    // 缺省（旧配置无该键）等价 'auto'，故与 'auto' 一并视为无变化，避免空写触发一次核重启。
    if (next === stored || (next === 'auto' && stored == null)) return;
    setTunMtu(next === 'auto' ? '' : String(next));
    updateTun({ mtu: next });
  };

  // 数字输入（Conduit `.input.w-port`：窄口右对齐 mono tnum）。
  // placeholder 是本次新增的第 4 参（MTU 行用它显示 Auto 落值）；其余调用点不传，行为与原先一致。
  const numInput = (
    value: string,
    onChange: (v: string) => void,
    onBlur?: () => void,
    placeholder?: string
  ) => (
    <input
      className="input w-port mono tnum"
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ''))}
      onBlur={onBlur}
      // Enter 即提交（blur 触发 onBlur）。与同面板 dnsTimeout 的内联 input 对齐——否则填完按 Enter 无反馈、
      // 切页即丢输入。
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );

  const errText: React.CSSProperties = { fontSize: 11, color: 'hsl(var(--err))', marginTop: 4 };
  const errBorder = (on?: boolean): React.CSSProperties | undefined =>
    on ? { borderColor: 'hsl(var(--err))' } : undefined;

  return (
    <div className="set-panel" data-set-panel="network">
      {(isMac || isWin || isLinux) && <HelperManagementCard />}

      <div className="card set-card">
        <div className="set-h">
          <b>{t('settings.advanced.dnsSettings')}</b>
          <small>{t('settings.network.dnsCardSub', '域名解析、FakeIP 与节点解析器')}</small>
        </div>
        <Srow
          stacked
          label={t('settings.advanced.domesticDns')}
          desc={t('settings.advanced.domesticDnsDesc')}
        >
          <input
            className="input mono"
            value={domesticDns}
            onChange={(e) => {
              setDomesticDns(e.target.value);
              if (dnsError.domesticDns) setDnsError((p) => ({ ...p, domesticDns: false }));
            }}
            onBlur={() => commitDns('domesticDns', domesticDns)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            aria-invalid={dnsError.domesticDns}
            style={errBorder(dnsError.domesticDns)}
            placeholder={t('settings.advanced.domesticDnsPlaceholder')}
          />
          {dnsError.domesticDns && <p style={errText}>{t('settings.advanced.dnsInvalid')}</p>}
        </Srow>
        <Srow
          stacked
          label={t('settings.advanced.foreignDns')}
          desc={t('settings.advanced.foreignDnsDesc')}
        >
          <input
            className="input mono"
            value={foreignDns}
            onChange={(e) => {
              setForeignDns(e.target.value);
              if (dnsError.foreignDns) setDnsError((p) => ({ ...p, foreignDns: false }));
            }}
            onBlur={() => commitDns('foreignDns', foreignDns)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            aria-invalid={dnsError.foreignDns}
            style={errBorder(dnsError.foreignDns)}
            placeholder={t('settings.advanced.foreignDnsPlaceholder')}
          />
          {dnsError.foreignDns && <p style={errText}>{t('settings.advanced.dnsInvalid')}</p>}
        </Srow>
        <Srow
          label={
            <>
              {t('settings.advanced.enableFakeIp')}
              <InfoTooltip content={t('settings.advanced.fakeIpDescFull')} />
            </>
          }
          desc={t('settings.advanced.fakeIpDesc')}
        >
          <Swt checked={config.dnsConfig?.enableFakeIp ?? true} onChange={handleFakeIpToggle} />
        </Srow>
        <AlertDialog open={fakeIpOffConfirmOpen} onOpenChange={setFakeIpOffConfirmOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{t('settings.advanced.fakeIpTunOffConfirmTitle')}</AlertDialogTitle>
              <AlertDialogDescription>
                {t('settings.advanced.fakeIpTunOffConfirmDesc')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
              <AlertDialogAction onClick={() => writeFakeIp(false)}>
                {t('settings.advanced.fakeIpTunOffConfirmOk')}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Collapse summary={t('settings.network.advancedDns', '高级 DNS')}>
          <Srow
            label={
              <>
                {t('settings.advanced.fakeIpFilter', 'FakeIP 例外域名')}
                <InfoTooltip content={t('settings.advanced.fakeIpFilterDescFull')} />
              </>
            }
            desc={t('settings.advanced.fakeIpFilterDesc')}
          >
            <Swt
              checked={config.fakeIpFilter !== false}
              onChange={(c) => setBool('fakeIpFilter', c)}
            />
          </Srow>
          {config.fakeIpFilter !== false && (
            <ExceptionList
              value={config.fakeIpFilterList}
              defaults={DEFAULT_FAKEIP_FILTER_DOMAINS}
              onChange={(v) =>
                saveConfig({ ...config, fakeIpFilterList: v }).catch(() =>
                  toast.error(t('common.saveFailed'))
                )
              }
              placeholder={t(
                'settings.advanced.fakeIpFilterPlaceholder',
                '每行一个域名，例如：\ntime.example.com\nstun.example.com'
              )}
              hint={t(
                'settings.advanced.fakeIpFilterEditHint',
                '每行一个域名；可增删，恢复默认回到内置清单。'
              )}
            />
          )}
          {/* #347 拨号前解析目的域名：**不与 FakeIP 联动**——mixed-in 入站无条件发射，走它的流量目的地
              恒为域名，关掉 FakeIP 并不会让本开关失去意义（谓词 resolvesDestinationAhead 同口径）。 */}
          <Srow
            label={
              <>
                {t('settings.advanced.resolveDestination', '拨号前解析目标域名')}
                <InfoTooltip content={t('settings.advanced.resolveDestinationDescFull')} />
              </>
            }
            desc={t('settings.advanced.resolveDestinationDesc')}
          >
            <Swt
              checked={config.resolveDestination === true}
              onChange={(c) => setBool('resolveDestination', c)}
            />
          </Srow>
          {/* 节点域名解析容错（issue #147 多源 race）：Switch 开关在上控制下方上游选择 on(多选 race 池)/off(单选)。 */}
          <Srow
            label={
              <>
                {t('settings.advanced.resolveNodeDomainsAhead')}
                <InfoTooltip content={t('settings.advanced.resolveNodeDomainsAheadDescFull')} />
              </>
            }
            desc={t('settings.advanced.resolveNodeDomainsAheadDesc')}
          >
            <Swt
              checked={config.dnsConfig?.resolveNodeDomainsAhead !== false}
              onChange={(c) => updateDns({ resolveNodeDomainsAhead: c })}
            />
          </Srow>
          <NodeResolverSection
            dns={config.dnsConfig}
            isLinux={isLinux}
            isTun={isTunMode}
            onUpdate={updateDns}
          />
          <Srow
            label={
              <>
                {t('settings.advanced.takeoverSystemDns', 'TUN 接管系统 DNS')}
                <InfoTooltip
                  content={t(
                    isMac
                      ? 'settings.advanced.takeoverSystemDnsDescFull'
                      : isLinux
                        ? 'settings.advanced.takeoverSystemDnsDescFullLinux'
                        : 'settings.advanced.takeoverSystemDnsDescFullOther'
                  )}
                />
              </>
            }
            desc={t(
              isMac
                ? 'settings.advanced.takeoverSystemDnsDesc'
                : isLinux
                  ? 'settings.advanced.takeoverSystemDnsDescLinux'
                  : 'settings.advanced.takeoverSystemDnsDescOther'
            )}
          >
            <Swt
              checked={config.dnsConfig?.takeoverSystemDns !== false}
              onChange={(c) => updateDns({ takeoverSystemDns: c })}
            />
          </Srow>
          <Srow
            label={
              <>
                {t('settings.advanced.optimisticCache', '乐观 DNS 缓存')}
                <InfoTooltip content={t('settings.advanced.optimisticCacheDescFull')} />
              </>
            }
            desc={t('settings.advanced.optimisticCacheDesc')}
          >
            <Swt
              checked={config.dnsConfig?.optimisticCache === true}
              onChange={(c) => updateDns({ optimisticCache: c })}
            />
          </Srow>
          <Srow
            label={
              <>
                {t('settings.advanced.dnsTimeout', 'DNS 查询超时')}
                <InfoTooltip
                  content={t('settings.advanced.dnsTimeoutDescFull', {
                    min: DNS_TIMEOUT_MIN_MS,
                    max: DNS_TIMEOUT_MAX_MS,
                  })}
                />
              </>
            }
            desc={t('settings.advanced.dnsTimeoutDesc')}
          >
            <input
              className="input w-port mono tnum"
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={dnsTimeout}
              onChange={(e) => setDnsTimeout(e.target.value.replace(/[^0-9]/g, ''))}
              onBlur={commitDnsTimeout}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
              placeholder={t('settings.advanced.dnsTimeoutPlaceholder', '默认')}
            />
          </Srow>
        </Collapse>
      </div>

      <div className="card set-card">
        <div className="set-h">
          <b>{t('settings.advanced.localProxyLan', '本地代理 / 局域网')}</b>
          <small>{t('settings.network.localProxyLanSub', '端口、LAN 共享与 TUN 排除')}</small>
        </div>
        <Srow
          label={
            <>
              {t('settings.advanced.localPort', '本地端口')}
              <InfoTooltip content={t('settings.advanced.localPortDescFull')} />
            </>
          }
          desc={t('settings.advanced.localPortDesc')}
        >
          {numInput(localPort, setLocalPort, commitLocalPort)}
        </Srow>
        <Srow
          label={
            <>
              {t('settings.advanced.allowLan')}
              <InfoTooltip content={t('settings.advanced.allowLanGatewayTipFull')} />
            </>
          }
          desc={t('settings.advanced.allowLanDesc')}
        >
          <Swt checked={config.allowLan === true} onChange={(c) => setBool('allowLan', c)} />
        </Srow>
        {config.allowLan && (
          <div className="srow-warn">{t('settings.advanced.allowLanGatewayTip')}</div>
        )}
        <Srow label={t('settings.advanced.bypassLAN')} desc={t('settings.advanced.bypassLANDesc')}>
          <Swt checked={config.bypassLAN !== false} onChange={(c) => setBool('bypassLAN', c)} />
        </Srow>
        {config.bypassLAN !== false && (
          <ExceptionList
            value={config.bypassLANList}
            defaults={DEFAULT_BYPASS_LAN}
            onChange={(v) =>
              saveConfig({ ...config, bypassLANList: v }).catch(() =>
                toast.error(t('common.saveFailed'))
              )
            }
            placeholder={t(
              'settings.advanced.bypassCidrPlaceholder',
              '每行一个 IP 段，例如：\n192.168.0.0/16\n10.0.0.0/8'
            )}
            hint={
              isWin && isTunMode
                ? t(
                    'settings.advanced.bypassLANEditHintWinTun',
                    'Windows TUN 下此清单为内核级排除：自定义规则无法覆盖。需让某段走代理请从此清单移除该段（组网路由段已自动放行进 TUN）。'
                  )
                : undefined
            }
            hintTone="warning"
          />
        )}

        {/* TUN「连入来源排除」：本机作服务端被 off-subnet 私网连入时，声明来源网段绕过 TUN 捕获（route_exclude_address）。
            仅 TUN 模式显示（三平台适用；生成期减组网段/fakeip 段，macOS 额外减本机物理 LAN 段）。 */}
        {isTunMode && (
          <>
            <Srow
              label={
                <>
                  {t('settings.advanced.tunInboundExclude', 'TUN 连入来源排除')}
                  <span className="pill region">{t('settings.network.onlyTun', '仅 TUN')}</span>
                  <InfoTooltip
                    content={t(
                      'settings.advanced.tunInboundExcludeDescFull',
                      '区别于「绕过局域网」：后者是分流直连偏好、不影响是否进 TUN；本项直接把网段排除出 TUN 捕获。注意这是**双向**的——被排除的段出/入两个方向都绕过 TUN 走直连，故这些段也不再经代理/自定义规则出网。与组网(WG/Tailscale)路由段重叠的会自动跳过（组网优先）；macOS 会跳过本机物理局域网段。一般用户无需设置。'
                    )}
                  />
                </>
              }
              desc={t(
                'settings.advanced.tunInboundExcludeDesc',
                '被这些网段远程连入本机（如经组网/NAT 访问本机服务）时，让回包绕过 TUN、走物理网卡，避免连接被劫持中断。'
              )}
            />
            {isLinux && (
              <div className="srow-warn muted">
                {t(
                  'settings.advanced.tunInboundExcludeLinuxNote',
                  'Linux 下服务端连入回包已由内核策略路由天然保护，此项不生效、已忽略（填写不会有效果）。'
                )}
              </div>
            )}
            <ExceptionList
              value={config.tunConfig?.inboundExcludeCidrs}
              defaults={[]}
              onChange={(v) => updateTun({ inboundExcludeCidrs: v })}
              placeholder={t(
                'settings.advanced.tunInboundExcludePlaceholder',
                '每行一个 IP 段（CIDR），例如：\n10.147.0.0/16\n192.168.5.0/24'
              )}
              hint={t(
                'settings.advanced.tunInboundExcludeHint',
                '每行一个 CIDR；非法项保存时自动剔除。用于「本机被远程管理/被连入」场景。'
              )}
            />
          </>
        )}

        {/* P6 局域网网关（sing-box 1.14 LAN 设备识别）：邻居短名解析（Linux/macOS）+ TUN MAC 过滤（仅 Linux）。
            仅 TUN 模式 + 受支持平台显示。 */}
        {isTunMode && (isLinux || isMac) && (
          <Collapse
            summary={
              <>
                {t('settings.advanced.lanGateway', '局域网网关')}
                <span className="pill region">
                  {t('settings.network.onlyTunLinuxMac', '仅 TUN · Linux / macOS')}
                </span>
              </>
            }
          >
            <Srow
              label={
                <>
                  {t('settings.advanced.neighborDomains', '局域网短名解析')}
                  <InfoTooltip content={t('settings.advanced.neighborDomainsDescFull')} />
                </>
              }
              desc={t('settings.advanced.neighborDomainsDesc')}
            />
            <ExceptionList
              value={config.tunConfig?.neighborDomains}
              defaults={[]}
              onChange={(v) => updateTun({ neighborDomains: v })}
              placeholder={t('settings.advanced.neighborDomainsPlaceholder', '.lan\n.home')}
              hint={t(
                'settings.advanced.neighborDomainsHint',
                '每行一个后缀（自动补前导点）；对该后缀下无点的短名（如 nas.lan）走局域网设备解析。'
              )}
            />

            {/* TUN MAC 过滤（仅 Linux + auto_route + auto_redirect）：按 MAC 限/排设备进 TUN */}
            {isLinux && (
              <>
                <Srow
                  label={
                    <>
                      {t('settings.advanced.macFilter', '按 MAC 过滤设备')}
                      <span className="pill region">
                        {t('settings.network.onlyLinux', '仅 Linux')}
                      </span>
                      <InfoTooltip content={t('settings.advanced.macFilterDescFull')} />
                    </>
                  }
                  desc={t('settings.advanced.macFilterDesc')}
                >
                  <div className="sel">
                    <select
                      aria-label={t('settings.advanced.macFilter', '按 MAC 过滤设备')}
                      value={config.tunConfig?.macFilterMode ?? 'off'}
                      onChange={(e) =>
                        updateTun({
                          macFilterMode:
                            e.target.value === 'off'
                              ? undefined
                              : (e.target.value as 'include' | 'exclude'),
                        })
                      }
                    >
                      <option value="off">{t('settings.advanced.macFilterOff', '关闭')}</option>
                      <option value="include">
                        {t('settings.advanced.macFilterInclude', '仅允许')}
                      </option>
                      <option value="exclude">
                        {t('settings.advanced.macFilterExclude', '排除')}
                      </option>
                    </select>
                  </div>
                </Srow>
                {config.tunConfig?.macFilterMode && (
                  <ExceptionList
                    value={config.tunConfig?.macFilterList}
                    defaults={[]}
                    onChange={(v) => updateTun({ macFilterList: v })}
                    placeholder={'00:11:22:33:44:55\naa:bb:cc:dd:ee:ff'}
                    hint={t(
                      'settings.advanced.macFilterHint',
                      '每行一个 MAC（00:11:22:33:44:55）；需 auto_route 开启，仅 Linux 生效。'
                    )}
                  />
                )}
              </>
            )}
          </Collapse>
        )}
      </div>

      {isTunMode && (
        <div className="card set-card">
          <div className="set-h">
            <b>{t('settings.advanced.tunMode', 'TUN 模式')}</b>
            <small>{t('settings.network.tunModeSub', '虚拟网卡网络栈（仅 TUN 接管时显示）')}</small>
          </div>
          <Srow
            label={
              <>
                {t('settings.advanced.tunStack', '网络栈')}
                <InfoTooltip content={t('settings.advanced.tunStackDescFull')} />
              </>
            }
            desc={t(
              isMac
                ? 'settings.advanced.tunStackDescMac'
                : isWin
                  ? 'settings.advanced.tunStackDescWin'
                  : 'settings.advanced.tunStackDescLinux'
            )}
          >
            <div className="sel">
              <select
                aria-label={t('settings.advanced.tunStack', '网络栈')}
                value={config.tunConfig?.stack ?? 'auto'}
                onChange={(e) => updateTun({ stack: e.target.value as TunStack })}
              >
                <option value="auto">
                  {`${t('settings.advanced.tunStackAuto', 'Auto')} (${autoResolvedStack})`}
                </option>
                {CONCRETE_TUN_STACKS.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
          </Srow>
          {/* MTU：空 = Auto，占位符显示 Auto 在【当前所选栈】下的实际落值（同一 MTU 在不同栈下差异可达数量级，
              只按平台显示会误导）。放在栈选择器下方，因其取值语义依赖栈。 */}
          <Srow
            label={
              <>
                {t('settings.advanced.tunMtu', 'MTU')}
                <InfoTooltip
                  content={t('settings.advanced.tunMtuDescFull', {
                    min: TUN_MTU_MIN,
                    max: TUN_MTU_MAX,
                  })}
                />
              </>
            }
            desc={t('settings.advanced.tunMtuDesc')}
          >
            {numInput(
              tunMtu,
              setTunMtu,
              commitTunMtu,
              `${t('settings.advanced.tunStackAuto', 'Auto')} (${resolveTunMtu(
                'auto',
                platform,
                resolveTunStack(config.tunConfig?.stack, platform)
              )})`
            )}
          </Srow>
          {/* 已知坏组合非阻断提示（不禁止：与 mac 允许显式选 system/mixed 的 honor 原则一致，由用户知情决定）。
              判据用【已解析的具体栈】，因为 Auto 在 Windows 落 gvisor 时该组合并不成立。 */}
          {isDegradedMtuCombo(
            resolveTunStack(config.tunConfig?.stack, platform),
            config.tunConfig?.mtu,
            platform
          ) && (
            <div className="srow-warn">
              {t('settings.advanced.tunMtuBadComboWarn', {
                safeMax: TUN_MTU_SAFE_MAX_NON_GVISOR,
              })}
            </div>
          )}
        </div>
      )}

      <div className="card set-card">
        <div className="set-h">
          <b>{t('settings.network.connection')}</b>
          <small>{t('settings.network.connectionSub', '切换行为与 QUIC / TLS / IPv6 治理')}</small>
        </div>
        <Srow
          label={t('settings.advanced.autoSwitchNode')}
          desc={t('settings.advanced.autoSwitchNodeDesc')}
        >
          <Swt
            checked={config.autoSwitchNode === true}
            onChange={(c) => setBool('autoSwitchNode', c)}
          />
        </Srow>
        <Srow
          label={t('settings.network.meshLoginFallback', '组网登录期出口让位')}
          desc={t(
            'settings.network.meshLoginFallbackDesc',
            '所选 Tailscale 出口尚未连接时，登录/授权期间默认路由临时走直连（避免授权页打不开导致卡死），连接成功后自动切回该出口。关闭则登录期不直连（宁可授权失败也不产生直连流量）。'
          )}
        >
          <Swt
            checked={config.meshLoginFallbackDirect !== false}
            onChange={(c) => setBool('meshLoginFallbackDirect', c)}
          />
        </Srow>
        <Srow
          label={
            <span style={{ color: 'hsl(var(--warn))' }}>{t('settings.general.enableIPv6')}</span>
          }
          desc={t('settings.network.enableIPv6Desc')}
        >
          <Swt checked={config.enableIPv6 === true} onChange={(c) => setBool('enableIPv6', c)} />
        </Srow>
        {/* 与上面的 enableIPv6 开关强耦合：拨开关的**同一视野**里就要看到后果提示与一键补救，故必须与开关相邻。
            开关从「高级流量」折叠区上提时，本块一并上提——留在折叠区等于用户拨完开关看不到提示。 */}
        {config.proxyModeType === 'tun' &&
          config.enableIPv6 === true &&
          config.dnsConfig?.enableFakeIp === false && (
            <div
              className="srow-warn"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
              }}
            >
              <span>
                {t(
                  'settings.network.ipv6NodeFakeIpHint',
                  '若节点不支持 IPv6，部分网站可能无法访问；建议开启 FakeIP。'
                )}
              </span>
              <button
                type="button"
                className="btn flow sm"
                style={{ flex: 'none' }}
                onClick={() => writeFakeIp(true)}
              >
                {t('settings.network.enableFakeIpAction', '开启 FakeIP')}
              </button>
            </div>
          )}
        <Collapse summary={t('settings.network.advancedTraffic', '高级流量')}>
          <Srow
            label={
              <>
                {t('settings.advanced.blockQuic')}
                <InfoTooltip content={t('settings.advanced.blockQuicDescFull')} />
              </>
            }
            desc={t('settings.advanced.blockQuicDesc')}
          >
            <Swt checked={config.blockQuic === true} onChange={(c) => setBool('blockQuic', c)} />
          </Srow>
          {/* 浏览器自带 DoH 会绕开系统 UDP 53 → 绕开 hijack-dns/FakeIP，分流退化成 IP 级。默认开；
              清单可编辑是必需的：按域名拦本质是黑名单，换个提供商即绕过，内置固定表必然漏。 */}
          <Srow
            label={
              <>
                {t('settings.advanced.blockBrowserDoh')}
                <InfoTooltip content={t('settings.advanced.blockBrowserDohDescFull')} />
              </>
            }
            desc={t('settings.advanced.blockBrowserDohDesc')}
          >
            <Swt
              checked={config.blockBrowserDoh !== false}
              onChange={(c) => setBool('blockBrowserDoh', c)}
            />
          </Srow>
          {config.blockBrowserDoh !== false && (
            <ExceptionList
              value={config.browserDohList}
              defaults={DEFAULT_BROWSER_DOH_KEYWORDS}
              onChange={(v) =>
                saveConfig({ ...config, browserDohList: v }).catch(() =>
                  toast.error(t('common.saveFailed'))
                )
              }
              placeholder={t('settings.advanced.browserDohPlaceholder')}
              hint={t('settings.advanced.browserDohEditHint')}
            />
          )}
          <Srow
            label={
              <>
                {t('settings.network.webrtcLeakProtection')}
                <InfoTooltip content={t('settings.network.webrtcLeakProtectionDescFull')} />
              </>
            }
            desc={t('settings.network.webrtcLeakProtectionDesc')}
          >
            <div className="sel">
              <select
                aria-label={t('settings.network.webrtcLeakProtection')}
                value={config.webrtcLeakProtection ?? 'off'}
                disabled={!isTunMode}
                onChange={(e) =>
                  saveConfig({
                    ...config,
                    webrtcLeakProtection: e.target.value as 'off' | 'proxy' | 'block',
                  }).catch(() => toast.error(t('common.saveFailed')))
                }
              >
                <option value="off">{t('settings.network.webrtcLeakOff')}</option>
                <option value="proxy">{t('settings.network.webrtcLeakProxy')}</option>
                <option value="block">{t('settings.network.webrtcLeakBlock')}</option>
              </select>
            </div>
          </Srow>
          {!isTunMode && (
            <div className="srow-warn muted">{t('settings.network.webrtcLeakTunOnlyHint')}</div>
          )}
          <Srow
            label={
              <>
                {t('settings.advanced.interruptOnSwitch')}
                <InfoTooltip content={t('settings.advanced.interruptOnSwitchDescFull')} />
              </>
            }
            desc={t('settings.advanced.interruptOnSwitchDesc')}
          >
            <Swt
              checked={config.interruptConnectionsOnSwitch === true}
              onChange={(c) => setBool('interruptConnectionsOnSwitch', c)}
            />
          </Srow>
          <Srow
            label={
              <>
                {t('settings.advanced.restartOnNodeChange')}
                <InfoTooltip content={t('settings.advanced.restartOnNodeChangeDescFull')} />
              </>
            }
            desc={t('settings.advanced.restartOnNodeChangeDesc')}
          >
            <Swt
              checked={config.restartOnNodeChange === true}
              onChange={(c) => setBool('restartOnNodeChange', c)}
            />
          </Srow>
          <Srow
            label={
              <>
                {t('settings.advanced.tlsFragment')}
                <InfoTooltip content={t('settings.advanced.tlsFragmentDescFull')} />
              </>
            }
            desc={t('settings.advanced.tlsFragmentDesc')}
          >
            <Swt
              checked={config.tlsFragment === true}
              onChange={(c) => setBool('tlsFragment', c)}
            />
          </Srow>
        </Collapse>
      </div>

      <div className="card set-card">
        <div className="set-h">
          <b>{t('settings.network.updateAndSpeedTest', '更新与测速')}</b>
          <small>
            {t('settings.network.updateAndSpeedTestSub', '订阅自动更新、更新流量走向与测速端点')}
          </small>
        </div>
        <Srow
          label={t('settings.advanced.autoUpdateSub')}
          desc={t('settings.advanced.autoUpdateSubDesc')}
        >
          <Swt
            checked={config.autoUpdateSubscriptionOnStart === true}
            onChange={(c) => setBool('autoUpdateSubscriptionOnStart', c)}
          />
        </Srow>
        {config.autoUpdateSubscriptionOnStart && (
          <Srow
            label={t('settings.advanced.subUpdateInterval')}
            desc={t('settings.advanced.subUpdateIntervalDesc')}
          >
            {numInput(subInterval, setSubInterval, () => {
              const n = parseInt(subInterval, 10);
              if (isNaN(n) || n < 1 || n > 168) {
                toast.error(t('settings.advanced.subIntervalRange'));
                setSubInterval(config.subscriptionUpdateIntervalHours?.toString() || '12');
                return;
              }
              if (n === config.subscriptionUpdateIntervalHours) return; // 无变化不保存
              saveConfig({ ...config, subscriptionUpdateIntervalHours: n }).catch(() =>
                toast.error(t('common.saveFailed'))
              );
            })}
          </Srow>
        )}
        {/* 订阅代理策略：恒显示（手动更新订阅亦生效） */}
        <Srow
          label={
            <>
              {t('settings.advanced.subUpdateViaProxy')}
              <InfoTooltip content={t('settings.advanced.subUpdateViaProxyDescFull')} />
            </>
          }
          desc={t('settings.advanced.subUpdateViaProxyDesc')}
        >
          <div className="sel">
            <select
              aria-label={t('settings.advanced.subUpdateViaProxy')}
              value={config.subscriptionProxyPolicy ?? 'follow'}
              onChange={(e) =>
                saveConfig({
                  ...config,
                  subscriptionProxyPolicy: e.target.value as 'follow' | 'proxy' | 'direct',
                }).catch(() => toast.error(t('common.saveFailed')))
              }
            >
              <option value="follow">
                {t('settings.advanced.subProxyPolicyFollow', '跟随订阅设置')}
              </option>
              <option value="proxy">
                {t('settings.advanced.subProxyPolicyProxy', '全部经代理')}
              </option>
              <option value="direct">
                {t('settings.advanced.subProxyPolicyDirect', '全部直连')}
              </option>
            </select>
          </div>
        </Srow>
        <Srow
          label={
            <>
              {t('settings.advanced.mainSessionViaProxy', '更新检查走代理')}
              <InfoTooltip content={t('settings.advanced.mainSessionViaProxyDescFull')} />
            </>
          }
          desc={t('settings.advanced.mainSessionViaProxyDesc')}
        >
          <Swt
            checked={config.mainSessionViaProxy !== false}
            onChange={(checked) =>
              saveConfig({ ...config, mainSessionViaProxy: checked }).catch(() =>
                toast.error(t('common.saveFailed'))
              )
            }
          />
        </Srow>
        <Srow
          stacked
          label={
            <>
              {t('settings.network.speedTestUrl')}
              <InfoTooltip content={t('settings.network.speedTestUrlDescFull')} />
            </>
          }
          desc={t('settings.network.speedTestUrlDesc')}
        >
          <input
            className="input mono"
            value={speedTestUrl}
            onChange={(e) => {
              setSpeedTestUrl(e.target.value);
              if (speedTestUrlError) setSpeedTestUrlError(false);
            }}
            onBlur={() => commitSpeedTestUrl(speedTestUrl)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
            aria-invalid={speedTestUrlError}
            style={errBorder(speedTestUrlError)}
            placeholder={DEFAULT_SPEED_TEST_URL}
          />
          {speedTestUrlError && <p style={errText}>{t('settings.network.speedTestUrlInvalid')}</p>}
        </Srow>
      </div>

      {/* 终端代理速查表（从「高级」节迁入，默认折叠；自渲染 .card.set-card） */}
      <TerminalProxySection
        httpPort={(config.mixedPort || config.httpPort || 7890).toString()}
        socksPort={(config.mixedPort || config.httpPort || 7890).toString()}
      />
    </div>
  );
}

/**
 * 节点域名解析上游选择（issue #147 多源 race）。受 resolveNodeDomainsAhead 控制形态：
 *  - 开（!== false）= 多选 race 池：Tier1（加密 DoH/DoT，上限 3）抢跑段 + Tier2（system / 明文 UDP）兜底段，
 *    勾选写入 nodeResolverPool；可添加/删除自定义纯 IP 上游（写入 nodeResolverCustom，添加自动勾选进 pool）。
 *  - 关 = 单选：一个 select 列全部上游，写入 nodeResolverSingle。
 * 不变量：pool(on) 与 single(off) 各存各的，切 Switch 互不覆盖（本组件只读写各自字段）。
 */
function NodeResolverSection({
  dns,
  isLinux,
  isTun,
  onUpdate,
}: {
  dns: DnsConfig | undefined;
  isLinux: boolean;
  isTun: boolean;
  onUpdate: (patch: Partial<DnsConfig>) => void;
}) {
  const { t } = useTranslation();
  const [customSpec, setCustomSpec] = useState('');

  const raceOn = dns?.resolveNodeDomainsAhead !== false;
  // memo 稳定空数组引用，使下方按 [custom] 的 useMemo 依赖在 nodeResolverCustom 未变时真正稳定。
  const custom: CustomDnsUpstream[] = useMemo(
    () => dns?.nodeResolverCustom ?? [],
    [dns?.nodeResolverCustom]
  );
  // pool 缺省 = DEFAULT_POOL_IDS（ali+dnspod）；显式空数组才视为「全不勾」由后端回退默认（此处只如实回显）。
  const pool: string[] = dns?.nodeResolverPool ?? [...DEFAULT_POOL_IDS];
  const single = dns?.nodeResolverSingle ?? DEFAULT_SINGLE_ID;

  // 自定义按 Tier 分桶（tier1 入抢跑段、tier2 入兜底段；解析失败的脏数据跳过）。
  const customTier1 = useMemo(
    () => custom.filter((c) => parseCustomUpstream(c)?.tier === 1),
    [custom]
  );
  const customTier2 = useMemo(
    () => custom.filter((c) => parseCustomUpstream(c)?.tier === 2),
    [custom]
  );

  // 抢跑段（Tier1）= 内置 ali/dnspod + 自定义 tier1；兜底段（Tier2）= 自定义 tier2 + system（恒置底）。
  const tier1Items: { id: string; label: string; custom?: CustomDnsUpstream }[] = [
    { id: 'ali', label: t('settings.advanced.nodeResolverAli') },
    { id: 'dnspod', label: t('settings.advanced.nodeResolverDnspod') },
    ...customTier1.map((c) => ({ id: c.id, label: c.spec, custom: c })),
  ];
  const tier2Items: { id: string; label: string; custom?: CustomDnsUpstream }[] = [
    ...customTier2.map((c) => ({ id: c.id, label: c.spec, custom: c })),
    {
      id: 'system',
      label:
        t('settings.advanced.nodeResolverSystem') +
        (isLinux && isTun ? ` (${t('settings.advanced.nodeResolverExperimental')})` : ''),
    },
  ];

  const tier1Selected = tier1Items.filter((it) => pool.includes(it.id)).length;
  const tier1Full = tier1Selected >= MAX_TIER1_UPSTREAMS;

  const togglePool = (id: string, checked: boolean) => {
    const next = checked ? [...new Set([...pool, id])] : pool.filter((x) => x !== id);
    onUpdate({ nodeResolverPool: next });
  };

  const addCustom = () => {
    const spec = customSpec.trim();
    if (!spec) return;
    if (!isValidCustomUpstreamSpec(spec)) {
      toast.error(t('settings.advanced.nodeResolverErrDomain'));
      return;
    }
    // canonical 去重：临时 id 算 key，比内置 + 已加自定义。
    const probe = parseCustomUpstream({ id: '_probe', spec });
    if (!probe) {
      toast.error(t('settings.advanced.nodeResolverErrDomain'));
      return;
    }
    const newKey = upstreamCanonicalKey(probe);
    const existingKeys = new Set<string>([
      ...Object.values(BUILTIN_UPSTREAMS).map(upstreamCanonicalKey),
      ...custom
        .map(parseCustomUpstream)
        .filter((u): u is NonNullable<typeof u> => u != null)
        .map(upstreamCanonicalKey),
    ]);
    if (existingKeys.has(newKey)) {
      toast.error(t('settings.advanced.nodeResolverErrDuplicate'));
      return;
    }
    const id = `custom-${Date.now().toString(36)}`;
    onUpdate({
      nodeResolverCustom: [...custom, { id, spec }],
      nodeResolverPool: [...new Set([...pool, id])], // 添加即自动勾选进 pool
    });
    setCustomSpec('');
  };

  const removeCustom = (id: string) => {
    onUpdate({
      nodeResolverCustom: custom.filter((c) => c.id !== id),
      nodeResolverPool: pool.filter((x) => x !== id), // 一并从 pool 移除
    });
  };

  // race off：单选内置上游（ali / dnspod / system）。off 单上游暂不支持自定义（§E 二期未实现）。
  if (!raceOn) {
    const singleItems = [
      { id: 'ali', label: t('settings.advanced.nodeResolverAli') },
      { id: 'dnspod', label: t('settings.advanced.nodeResolverDnspod') },
      {
        id: 'system',
        label:
          t('settings.advanced.nodeResolverSystem') +
          (isLinux && isTun ? ` (${t('settings.advanced.nodeResolverExperimental')})` : ''),
      },
    ];
    // single 若为陈旧/自定义 id（非内置）→ 回显 ali，与后端「未知 single 走 ali 基线」一致，避免空白选择。
    const singleValue = singleItems.some((it) => it.id === single) ? single : DEFAULT_SINGLE_ID;
    return (
      <>
        <Srow label={t('settings.advanced.nodeResolverSingleLabel')}>
          <div className="sel">
            <select
              aria-label={t('settings.advanced.nodeResolverSingleLabel')}
              value={singleValue}
              onChange={(e) => onUpdate({ nodeResolverSingle: e.target.value })}
            >
              {singleItems.map((it) => (
                <option key={it.id} value={it.id}>
                  {it.label}
                </option>
              ))}
            </select>
          </div>
        </Srow>
        <div className="ng-hint" style={{ padding: '2px 0 8px' }}>
          {t('settings.advanced.nodeResolverSingleHint')}
        </div>
      </>
    );
  }

  // race on：多选 race 池（抢跑段 + 兜底段 + 自定义）。
  const renderChkRow = (
    it: { id: string; label: string; custom?: CustomDnsUpstream },
    opts: { disabled?: boolean }
  ) => {
    const checked = pool.includes(it.id);
    return (
      <label key={it.id} className="chk-row">
        <input
          type="checkbox"
          checked={checked}
          disabled={opts.disabled && !checked}
          onChange={(e) => togglePool(it.id, e.target.checked)}
        />
        {it.label}
        {it.custom && (
          <button
            type="button"
            className="rm"
            aria-label={t('common.delete', 'Delete')}
            onClick={(e) => {
              e.preventDefault();
              removeCustom(it.custom!.id);
            }}
          >
            ×
          </button>
        )}
      </label>
    );
  };

  // race on 多选区默认折叠（nested Collapse）：折叠头展示「竞速上游 + 已选摘要」。
  const selectedItems = [...tier1Items, ...tier2Items].filter((it) => pool.includes(it.id));
  const summary =
    t('settings.advanced.nodeResolverSelectedCount', { count: selectedItems.length }) +
    (selectedItems.length > 0 ? ` · ${selectedItems.map((it) => it.label).join(', ')}` : '');
  return (
    <Collapse
      className="nested"
      summary={
        <>
          {t('settings.advanced.nodeResolverRaceHeading')}
          <span className="ng-hint">{summary}</span>
        </>
      }
    >
      <div className="ng-group">
        <div className="ng-row">
          <div className="ng-h">
            {t('settings.advanced.nodeResolverRaceGroup', '竞速组')}
            <span className="pill region">
              {t('settings.advanced.nodeResolverRaceGroupCap', '加密 · 上限 3')}
            </span>
          </div>
          <span className="ng-hint">{t('settings.advanced.nodeResolverRaceHint')}</span>
        </div>
        {tier1Items.map((it) => renderChkRow(it, { disabled: tier1Full }))}
      </div>

      <div className="ng-group bordered">
        <div className="ng-h">
          {t('settings.advanced.nodeResolverFallbackHeading')}
          <span className="ng-hint">{t('settings.advanced.nodeResolverFallbackHint')}</span>
        </div>
        {tier2Items.map((it) => renderChkRow(it, {}))}
      </div>

      {/* 添加自定义上游（纯 IP，去重） */}
      <div className="ng-add">
        <input
          className="input mono"
          value={customSpec}
          onChange={(e) => setCustomSpec(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              addCustom();
            }
          }}
          placeholder={t('settings.advanced.nodeResolverCustomPlaceholder')}
        />
        <button type="button" className="btn ghost sm" onClick={addCustom}>
          {t('settings.advanced.nodeResolverAddCustom')}
        </button>
      </div>
    </Collapse>
  );
}
