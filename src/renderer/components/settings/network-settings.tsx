import { useState, useEffect, useRef, useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import { parseDnsServerSpec } from '@shared/dns';
import {
  BUILTIN_UPSTREAMS,
  isValidCustomUpstreamSpec,
  parseCustomUpstream,
  upstreamCanonicalKey,
  MAX_TIER1_UPSTREAMS,
  DEFAULT_POOL_IDS,
  DEFAULT_SINGLE_ID,
} from '@shared/node-resolver-upstreams';
import type { CustomDnsUpstream, DnsConfig } from '@shared/types';
import { DEFAULT_BYPASS_LAN } from '@shared/system-proxy-bypass';
import { parseSpeedTestUrl, DEFAULT_SPEED_TEST_URL } from '@shared/speed-test';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { SettingsRow } from './settings-row';
import { SettingsCollapsible } from './settings-collapsible';
import { ExceptionList } from './exception-list';
import { DEFAULT_FAKEIP_FILTER_DOMAINS } from '../../../shared/fakeip-filter';
import { HelperManagementCard } from './helper-management-card';
import { TerminalProxySection } from './terminal-proxy-section';

const isMac = window.electron?.platform === 'darwin';
const isWin = window.electron?.platform === 'win32';
const isLinux = window.electron?.platform === 'linux';

const DNS_DEFAULTS = {
  domesticDns: 'https://doh.pub/dns-query',
  foreignDns: 'https://dns.google/dns-query',
} as const;

/**
 * 设置「网络」节：DNS / 端口 / 连接 / 订阅自动更新 / 提权助手。
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
  // P2c DNS 查询超时（毫秒；空 = 用核默认，不下发）。文本态便于「清空即重置默认」与 onBlur 提交。
  const [dnsTimeout, setDnsTimeout] = useState(
    config?.dnsConfig?.dnsTimeoutMs != null ? String(config.dnsConfig.dnsTimeoutMs) : ''
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
    };
    const prev = seededRef.current;
    setLocalPort((cur) => (prev && cur !== prev.localPort ? cur : snap.localPort));
    setSubInterval((cur) => (prev && cur !== prev.subInterval ? cur : snap.subInterval));
    setDomesticDns((cur) => (prev && cur !== prev.domesticDns ? cur : snap.domesticDns));
    setForeignDns((cur) => (prev && cur !== prev.foreignDns ? cur : snap.foreignDns));
    setSpeedTestUrl((cur) => (prev && cur !== prev.speedTestUrl ? cur : snap.speedTestUrl));
    setDnsTimeout((cur) => (prev && cur !== prev.dnsTimeout ? cur : snap.dnsTimeout));
    seededRef.current = snap;
  }, [
    config?.mixedPort,
    config?.httpPort,
    config?.subscriptionUpdateIntervalHours,
    config?.dnsConfig?.domesticDns,
    config?.dnsConfig?.foreignDns,
    config?.speedTestUrl,
    config?.dnsConfig?.dnsTimeoutMs,
  ]);

  if (!config) return null;

  // 切换布尔配置项（整体回写，保留其余字段）
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

  // P6 局域网网关：更新 tunConfig 子字段（MAC 过滤 / 邻居解析后缀），保留其余 TUN 设置。
  const updateTun = (patch: Partial<NonNullable<typeof config.tunConfig>>) =>
    saveConfig({ ...config, tunConfig: { ...config.tunConfig, ...patch } }).catch(() =>
      toast.error(t('common.saveFailed'))
    );

  // FakeIP 开关切换：TUN 模式下 ON→OFF 先弹一次性风险确认（节点将收真实 IP，部分机场可能拒连，客户端无法缓解）；
  // 其它情况（开启、或非 TUN 关闭）直接落盘。
  const handleFakeIpToggle = (checked: boolean) => {
    const isTun = config.proxyModeType?.toLowerCase() === 'tun';
    if (!checked && isTun) {
      setFakeIpOffConfirmOpen(true);
      return;
    }
    updateDns({ enableFakeIp: checked });
  };

  // F1：DNS 改为提交时保存（onBlur），而非逐键 saveConfig（代理运行时逐键会触发全量重启 + 受控回显竞态）。
  const commitDns = (key: 'domesticDns' | 'foreignDns', raw: string) => {
    const v = raw.trim();
    if (v && !parseDnsServerSpec(v)) {
      toast.error(t('settings.advanced.dnsInvalid'));
      return; // 非法值不落盘，保留输入文本待修正
    }
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
      toast.error(t('settings.network.speedTestUrlInvalid'));
      setSpeedTestUrl(config.speedTestUrl || DEFAULT_SPEED_TEST_URL); // 回滚到已存值
      return;
    }
    const next = v || DEFAULT_SPEED_TEST_URL; // 清空即重置默认
    setSpeedTestUrl(next);
    const stored = config.speedTestUrl || DEFAULT_SPEED_TEST_URL;
    if (next === stored) return; // 无变化不保存
    saveConfig({ ...config, speedTestUrl: next }).catch(() => toast.error(t('common.saveFailed')));
  };

  // P2c DNS 查询超时：onBlur 提交。空 = 清除（不下发，用核默认）；非空须为 1..60000 的整数毫秒，越界提示并回滚。
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
    if (isNaN(ms) || ms < 1 || ms > 60000) {
      toast.error(t('settings.advanced.dnsTimeoutRange', 'DNS 超时须为 1-60000 毫秒'));
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
    if (isNaN(portNum) || portNum < 1024 || portNum > 65535) {
      toast.error(t('settings.advanced.localPortRange', '端口须为 1024-65535'));
      revert();
      return;
    }
    if (portNum === cur) return; // 无变化
    setLocalPort(portNum.toString());
    saveConfig({ ...config, mixedPort: portNum }).catch(() => toast.error(t('common.saveFailed')));
  };

  const numInput = (
    value: string,
    onChange: (v: string) => void,
    className = 'w-[120px]',
    onBlur?: () => void
  ) => (
    <Input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/[^0-9]/g, ''))}
      onBlur={onBlur}
      className={className}
    />
  );

  return (
    <div className="space-y-6">
      {(isMac || isWin) && <HelperManagementCard />}

      {/* DNS */}
      <Card>
        <CardContent className="divide-y divide-border/60 pt-2">
          <SettingsRow heading label={t('settings.advanced.dnsSettings')} />
          <SettingsRow
            label={t('settings.advanced.domesticDns')}
            description={t('settings.advanced.domesticDnsDesc')}
            stacked
          >
            <Input
              value={domesticDns}
              onChange={(e) => setDomesticDns(e.target.value)}
              onBlur={() => commitDns('domesticDns', domesticDns)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
              className="max-w-md"
              placeholder={t('settings.advanced.domesticDnsPlaceholder')}
            />
          </SettingsRow>
          <SettingsRow
            label={t('settings.advanced.foreignDns')}
            description={t('settings.advanced.foreignDnsDesc')}
            stacked
          >
            <Input
              value={foreignDns}
              onChange={(e) => setForeignDns(e.target.value)}
              onBlur={() => commitDns('foreignDns', foreignDns)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
              className="max-w-md"
              placeholder={t('settings.advanced.foreignDnsPlaceholder')}
            />
          </SettingsRow>
          <SettingsRow
            label={t('settings.advanced.enableFakeIp')}
            description={t('settings.advanced.fakeIpDesc')}
            tooltip={t('settings.advanced.fakeIpDescFull')}
          >
            <Switch
              checked={config.dnsConfig?.enableFakeIp ?? true}
              onCheckedChange={handleFakeIpToggle}
            />
          </SettingsRow>
          <AlertDialog open={fakeIpOffConfirmOpen} onOpenChange={setFakeIpOffConfirmOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t('settings.advanced.fakeIpTunOffConfirmTitle')}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t('settings.advanced.fakeIpTunOffConfirmDesc')}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
                <AlertDialogAction onClick={() => updateDns({ enableFakeIp: false })}>
                  {t('settings.advanced.fakeIpTunOffConfirmOk')}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <SettingsCollapsible label={t('settings.network.advancedDns', '高级 DNS')} defaultOpen>
            <div>
              <SettingsRow
                label={t('settings.advanced.fakeIpFilter', 'FakeIP 例外域名')}
                description={t('settings.advanced.fakeIpFilterDesc')}
                tooltip={t('settings.advanced.fakeIpFilterDescFull')}
              >
                <Switch
                  checked={config.fakeIpFilter !== false}
                  onCheckedChange={(c) => setBool('fakeIpFilter', c)}
                />
              </SettingsRow>
              {config.fakeIpFilter !== false && (
                <ExceptionList
                  value={config.fakeIpFilterList}
                  defaults={DEFAULT_FAKEIP_FILTER_DOMAINS}
                  onChange={(v) =>
                    saveConfig({ ...config, fakeIpFilterList: v }).catch(() =>
                      toast.error(t('common.saveFailed'))
                    )
                  }
                  placeholder={'每行一个域名，例如：\ntime.example.com\nstun.example.com'}
                  hint={t(
                    'settings.advanced.fakeIpFilterEditHint',
                    '每行一个域名；可增删，恢复默认回到内置清单。'
                  )}
                />
              )}
            </div>
            {/* 节点域名解析容错（issue #147 多源 race）：Switch 开关在上控制下方上游选择 on(多选 race 池)/off(单选)。
                Switch on(!== false) → race 池多选；off → 单上游逃生。两态字段(pool / single)各存各的，互不覆盖。 */}
            <SettingsRow
              label={t('settings.advanced.resolveNodeDomainsAhead')}
              description={t('settings.advanced.resolveNodeDomainsAheadDesc')}
              tooltip={t('settings.advanced.resolveNodeDomainsAheadDescFull')}
            >
              <Switch
                checked={config.dnsConfig?.resolveNodeDomainsAhead !== false}
                onCheckedChange={(c) => updateDns({ resolveNodeDomainsAhead: c })}
              />
            </SettingsRow>
            <NodeResolverSection
              dns={config.dnsConfig}
              isLinux={isLinux}
              isTun={config.proxyModeType?.toLowerCase() === 'tun'}
              onUpdate={updateDns}
            />
            <SettingsRow
              label={t('settings.advanced.takeoverSystemDns', 'TUN 接管系统 DNS')}
              description={t(
                isMac
                  ? 'settings.advanced.takeoverSystemDnsDesc'
                  : 'settings.advanced.takeoverSystemDnsDescOther'
              )}
              tooltip={t(
                isMac
                  ? 'settings.advanced.takeoverSystemDnsDescFull'
                  : 'settings.advanced.takeoverSystemDnsDescFullOther'
              )}
            >
              <Switch
                checked={config.dnsConfig?.takeoverSystemDns !== false}
                onCheckedChange={(c) => updateDns({ takeoverSystemDns: c })}
              />
            </SettingsRow>
            <SettingsRow
              label={t('settings.advanced.optimisticCache', '乐观 DNS 缓存')}
              description={t('settings.advanced.optimisticCacheDesc')}
              tooltip={t('settings.advanced.optimisticCacheDescFull')}
            >
              <Switch
                checked={config.dnsConfig?.optimisticCache === true}
                onCheckedChange={(c) => updateDns({ optimisticCache: c })}
              />
            </SettingsRow>
            <SettingsRow
              label={t('settings.advanced.dnsTimeout', 'DNS 查询超时')}
              description={t('settings.advanced.dnsTimeoutDesc')}
              tooltip={t('settings.advanced.dnsTimeoutDescFull')}
            >
              <Input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={dnsTimeout}
                onChange={(e) => setDnsTimeout(e.target.value.replace(/[^0-9]/g, ''))}
                onBlur={commitDnsTimeout}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.currentTarget.blur();
                }}
                className="w-[120px]"
                placeholder={t('settings.advanced.dnsTimeoutPlaceholder', '默认')}
              />
            </SettingsRow>
          </SettingsCollapsible>
        </CardContent>
      </Card>

      {/* 本地代理 / 局域网（端口 + LAN 共享 + 系统代理 bypass 同主题归并） */}
      <Card>
        <CardContent className="divide-y divide-border/60 pt-2">
          <SettingsRow heading label={t('settings.advanced.localProxyLan', '本地代理 / 局域网')} />
          <SettingsRow
            label={t('settings.advanced.localPort', '本地端口')}
            description={t('settings.advanced.localPortDesc')}
            tooltip={t('settings.advanced.localPortDescFull')}
          >
            {numInput(localPort, setLocalPort, 'w-[120px]', commitLocalPort)}
          </SettingsRow>
          <div>
            <SettingsRow
              label={t('settings.advanced.allowLan')}
              description={t('settings.advanced.allowLanDesc')}
              tooltip={t('settings.advanced.allowLanGatewayTipFull')}
            >
              <Switch
                checked={config.allowLan === true}
                onCheckedChange={(c) => setBool('allowLan', c)}
              />
            </SettingsRow>
            {config.allowLan && (
              <p className="pb-2 text-xs font-medium text-warning">
                {t('settings.advanced.allowLanGatewayTip')}
              </p>
            )}
          </div>
          <div>
            <SettingsRow
              label={t('settings.advanced.bypassLAN')}
              description={t('settings.advanced.bypassLANDesc')}
            >
              <Switch
                checked={config.bypassLAN !== false}
                onCheckedChange={(c) => setBool('bypassLAN', c)}
              />
            </SettingsRow>
            {config.bypassLAN !== false && (
              <ExceptionList
                value={config.bypassLANList}
                defaults={DEFAULT_BYPASS_LAN}
                onChange={(v) =>
                  saveConfig({ ...config, bypassLANList: v }).catch(() =>
                    toast.error(t('common.saveFailed'))
                  )
                }
                placeholder={'每行一个 IP 段，例如：\n192.168.0.0/16\n10.0.0.0/8'}
                hint={t(
                  'settings.advanced.bypassLANEditHint',
                  '路由规则优先级高于此：需让某段走代理，可以从列表删除或者去「路由规则」加自定义规则即可覆盖。'
                )}
                hintTone="warning"
              />
            )}
          </div>

          {/* P6 局域网网关（sing-box 1.14 LAN 设备识别）：邻居短名解析（Linux/macOS）+ TUN MAC 过滤（仅 Linux）。
              仅 TUN 模式 + 受支持平台显示——非 TUN/非支持平台时这些字段构建期不发射，UI 隐藏避免误导。 */}
          {config.proxyModeType?.toLowerCase() === 'tun' && (isLinux || isMac) && (
            <SettingsCollapsible label={t('settings.advanced.lanGateway', '局域网网关')}>
              <div className="space-y-3 py-1">
                {/* 邻居短名解析后缀（Linux/macOS）：对这些后缀的单标签短名走局域网邻居解析 */}
                <div>
                  <SettingsRow
                    label={t('settings.advanced.neighborDomains', '局域网短名解析')}
                    description={t('settings.advanced.neighborDomainsDesc')}
                    tooltip={t('settings.advanced.neighborDomainsDescFull')}
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
                </div>

                {/* TUN MAC 过滤（仅 Linux + auto_route + auto_redirect）：按 MAC 限/排设备进 TUN */}
                {isLinux && (
                  <div>
                    <SettingsRow
                      label={t('settings.advanced.macFilter', '按 MAC 过滤设备')}
                      description={t('settings.advanced.macFilterDesc')}
                      tooltip={t('settings.advanced.macFilterDescFull')}
                    >
                      <Select
                        value={config.tunConfig?.macFilterMode ?? 'off'}
                        onValueChange={(v) =>
                          updateTun({
                            macFilterMode: v === 'off' ? undefined : (v as 'include' | 'exclude'),
                          })
                        }
                      >
                        <SelectTrigger className="w-[140px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="off">
                            {t('settings.advanced.macFilterOff', '关闭')}
                          </SelectItem>
                          <SelectItem value="include">
                            {t('settings.advanced.macFilterInclude', '仅允许')}
                          </SelectItem>
                          <SelectItem value="exclude">
                            {t('settings.advanced.macFilterExclude', '排除')}
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </SettingsRow>
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
                  </div>
                )}
              </div>
            </SettingsCollapsible>
          )}
        </CardContent>
      </Card>

      {/* 连接 / 流量（QUIC/TLS/IPv6 流量治理 + 切换/换节点/更新路由 行为） */}
      <Card>
        <CardContent className="divide-y divide-border/60 pt-2">
          <SettingsRow heading label={t('settings.network.connection')} />
          {/* 高频项常驻；低频流量治理折叠（C4/H3） */}
          <SettingsRow
            label={t('settings.advanced.autoSwitchNode')}
            description={t('settings.advanced.autoSwitchNodeDesc')}
          >
            <Switch
              checked={config.autoSwitchNode === true}
              onCheckedChange={(c) => setBool('autoSwitchNode', c)}
            />
          </SettingsRow>
          <SettingsCollapsible
            label={t('settings.network.advancedTraffic', '高级流量')}
            defaultOpen
          >
            <SettingsRow
              label={t('settings.advanced.blockQuic')}
              description={t('settings.advanced.blockQuicDesc')}
              tooltip={t('settings.advanced.blockQuicDescFull')}
            >
              <Switch
                checked={config.blockQuic === true}
                onCheckedChange={(c) => setBool('blockQuic', c)}
              />
            </SettingsRow>
            {/* WebRTC 防泄露（三态：关/走代理/阻断）。仅 TUN 模式生效——系统代理模式浏览器 WebRTC 的 UDP
                不经 sing-box 核，规则层拦不住，故非 TUN 时置灰 + 提示切到 TUN（避免用户误以为已防护）。 */}
            <div>
              <SettingsRow
                label={t('settings.network.webrtcLeakProtection')}
                description={t('settings.network.webrtcLeakProtectionDesc')}
                tooltip={t('settings.network.webrtcLeakProtectionDescFull')}
              >
                <Select
                  value={config.webrtcLeakProtection ?? 'off'}
                  onValueChange={(v) =>
                    saveConfig({
                      ...config,
                      webrtcLeakProtection: v as 'off' | 'proxy' | 'block',
                    }).catch(() => toast.error(t('common.saveFailed')))
                  }
                  disabled={config.proxyModeType?.toLowerCase() !== 'tun'}
                >
                  <SelectTrigger className="h-8 w-[160px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="off">{t('settings.network.webrtcLeakOff')}</SelectItem>
                    <SelectItem value="proxy">{t('settings.network.webrtcLeakProxy')}</SelectItem>
                    <SelectItem value="block">{t('settings.network.webrtcLeakBlock')}</SelectItem>
                  </SelectContent>
                </Select>
              </SettingsRow>
              {config.proxyModeType?.toLowerCase() !== 'tun' && (
                <p className="pb-2 text-xs font-medium text-muted-foreground">
                  {t('settings.network.webrtcLeakTunOnlyHint')}
                </p>
              )}
            </div>
            <SettingsRow
              label={t('settings.advanced.interruptOnSwitch')}
              description={t('settings.advanced.interruptOnSwitchDesc')}
              tooltip={t('settings.advanced.interruptOnSwitchDescFull')}
            >
              <Switch
                checked={config.interruptConnectionsOnSwitch === true}
                onCheckedChange={(c) => setBool('interruptConnectionsOnSwitch', c)}
              />
            </SettingsRow>
            <SettingsRow
              label={t('settings.advanced.tlsFragment')}
              description={t('settings.advanced.tlsFragmentDesc')}
              tooltip={t('settings.advanced.tlsFragmentDescFull')}
            >
              <Switch
                checked={config.tlsFragment === true}
                onCheckedChange={(c) => setBool('tlsFragment', c)}
              />
            </SettingsRow>
            <SettingsRow
              label={<span className="text-warning">{t('settings.general.enableIPv6')}</span>}
              description={t('settings.network.enableIPv6Desc')}
            >
              <Switch
                checked={config.enableIPv6 === true}
                onCheckedChange={(c) => setBool('enableIPv6', c)}
              />
            </SettingsRow>
            {/* 仅 TUN + IPv6 开 + FakeIP 关 才提示：TUN 下客户端会直接试 v6，节点若无 v6 则部分站点连不通；
                FakeIP 让节点按域名出站、规避此问题。系统代理模式经 127.0.0.1+域名(remote DNS)不犯此问题，故不提示。 */}
            {config.proxyModeType === 'tun' &&
              config.enableIPv6 === true &&
              config.dnsConfig?.enableFakeIp === false && (
                <div className="flex items-center justify-between gap-3 py-2">
                  <p className="text-xs font-medium text-warning">
                    {t(
                      'settings.network.ipv6NodeFakeIpHint',
                      '若节点不支持 IPv6，部分网站可能无法访问；建议开启 FakeIP。'
                    )}
                  </p>
                  <Button
                    size="sm"
                    className="shrink-0"
                    onClick={() => updateDns({ enableFakeIp: true })}
                  >
                    {t('settings.network.enableFakeIpAction', '开启 FakeIP')}
                  </Button>
                </div>
              )}
          </SettingsCollapsible>
        </CardContent>
      </Card>

      {/* 更新与测速（订阅自动更新 + 更新走代理 + 节点测速端点合并为一卡，C5/L2） */}
      <Card>
        <CardContent className="divide-y divide-border/60 pt-2">
          <SettingsRow heading label={t('settings.network.updateAndSpeedTest', '更新与测速')} />
          <SettingsRow
            label={t('settings.advanced.autoUpdateSub')}
            description={t('settings.advanced.autoUpdateSubDesc')}
          >
            <Switch
              checked={config.autoUpdateSubscriptionOnStart === true}
              onCheckedChange={(c) => setBool('autoUpdateSubscriptionOnStart', c)}
            />
          </SettingsRow>
          {config.autoUpdateSubscriptionOnStart && (
            <>
              <SettingsRow
                label={t('settings.advanced.subUpdateInterval')}
                description={t('settings.advanced.subUpdateIntervalDesc')}
              >
                {numInput(subInterval, setSubInterval, 'w-[100px]', () => {
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
              </SettingsRow>
              <SettingsRow
                label={t('settings.advanced.subUpdateViaProxy')}
                description={t('settings.advanced.subUpdateViaProxyDesc')}
                tooltip={t('settings.advanced.subUpdateViaProxyDescFull')}
              >
                <Switch
                  checked={config.subscriptionUpdateViaProxy === true}
                  onCheckedChange={(c) => setBool('subscriptionUpdateViaProxy', c)}
                />
              </SettingsRow>
            </>
          )}
          {/* 更新检查走代理（L2：与订阅更新同属「更新流量是否走代理」，从连接/流量卡归并至此） */}
          <SettingsRow
            label={t('settings.advanced.mainSessionViaProxy', '更新检查走代理')}
            description={t('settings.advanced.mainSessionViaProxyDesc')}
            tooltip={t('settings.advanced.mainSessionViaProxyDescFull')}
          >
            <Switch
              checked={config.mainSessionViaProxy !== false}
              onCheckedChange={(checked) =>
                saveConfig({ ...config, mainSessionViaProxy: checked }).catch(() =>
                  toast.error(t('common.saveFailed'))
                )
              }
            />
          </SettingsRow>
          <SettingsRow
            label={t('settings.network.speedTestUrl')}
            description={t('settings.network.speedTestUrlDesc')}
            tooltip={t('settings.network.speedTestUrlDescFull')}
            stacked
          >
            <Input
              value={speedTestUrl}
              onChange={(e) => setSpeedTestUrl(e.target.value)}
              onBlur={() => commitSpeedTestUrl(speedTestUrl)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') e.currentTarget.blur();
              }}
              className="max-w-md font-mono text-sm"
              placeholder={DEFAULT_SPEED_TEST_URL}
            />
          </SettingsRow>
        </CardContent>
      </Card>

      {/* 终端代理速查表（从「高级」节迁入，默认折叠；C3/L4） */}
      <Card>
        <CardContent className="pt-6">
          <TerminalProxySection
            httpPort={(config.mixedPort || config.httpPort || 7890).toString()}
            socksPort={(config.mixedPort || config.httpPort || 7890).toString()}
          />
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * 节点域名解析上游选择（issue #147 多源 race）。受 resolveNodeDomainsAhead 控制形态：
 *  - 开（!== false）= 多选 race 池：Tier1（加密 DoH/DoT，上限 3）抢跑段 + Tier2（system / 明文 UDP，不占额度）兜底段，
 *    勾选写入 nodeResolverPool；可添加/删除自定义纯 IP 上游（写入 nodeResolverCustom，添加自动勾选进 pool）。
 *  - 关 = 单选：一个 Select 列全部上游，写入 nodeResolverSingle。
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

  // 自定义按 Tier 分桶（tier1 入抢跑段、tier2 入兜底段；解析失败的脏数据跳过）。useMemo 仅在 custom 变化时重算 parse。
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

  // race off：单选内置上游（ali / dnspod / system）。
  // off 单上游暂不支持自定义（§E 二期未实现）：后端 getNodeResolverTag 对「off + 自定义 single」会静默回退 ali 基线，
  // 列出自定义会让用户选了却不生效，故仅在 race on 的多选里提供自定义；off 只列内置以保证所选即生效。
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
      <div className="space-y-2 py-3">
        <SettingsRow label={t('settings.advanced.nodeResolverSingleLabel')}>
          <Select value={singleValue} onValueChange={(v) => onUpdate({ nodeResolverSingle: v })}>
            <SelectTrigger className="h-8 w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {singleItems.map((it) => (
                <SelectItem key={it.id} value={it.id}>
                  {it.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsRow>
        <p className="text-xs text-muted-foreground">
          {t('settings.advanced.nodeResolverSingleHint')}
        </p>
      </div>
    );
  }

  // race on：多选 race 池（抢跑段 + 兜底段 + 自定义）。
  const renderItem = (
    it: { id: string; label: string; custom?: CustomDnsUpstream },
    opts: { disabled?: boolean }
  ) => {
    const checked = pool.includes(it.id);
    return (
      <div key={it.id} className="flex items-center gap-2">
        <Checkbox
          id={`node-resolver-${it.id}`}
          checked={checked}
          disabled={opts.disabled && !checked}
          onCheckedChange={(c) => togglePool(it.id, c === true)}
        />
        <Label
          htmlFor={`node-resolver-${it.id}`}
          className="cursor-pointer text-sm font-normal text-foreground"
        >
          {it.label}
        </Label>
        {it.custom && (
          <button
            type="button"
            aria-label={t('common.delete', 'Delete')}
            className="text-xs text-muted-foreground hover:text-destructive"
            onClick={() => removeCustom(it.custom!.id)}
          >
            ×
          </button>
        )}
      </div>
    );
  };

  // race on 多选区默认折叠（SettingsCollapsible）：折叠头展示「竞速上游 + 已选摘要」，
  // 点开才渲染完整三段（抢跑/兜底/自定义）。避免 checkbox 列表随自定义上游增多纵向撑长卡片（用户决策：保留 checkbox + 默认折叠）。
  const selectedItems = [...tier1Items, ...tier2Items].filter((it) => pool.includes(it.id));
  const summary =
    t('settings.advanced.nodeResolverSelectedCount', { count: selectedItems.length }) +
    (selectedItems.length > 0 ? ` · ${selectedItems.map((it) => it.label).join(', ')}` : '');
  return (
    <SettingsCollapsible
      label={
        <span className="flex flex-wrap items-baseline gap-x-2">
          <span>{t('settings.advanced.nodeResolverRaceHeading')}</span>
          <span className="text-xs font-normal text-muted-foreground">{summary}</span>
        </span>
      }
    >
      <div className="space-y-4 py-3">
        {/* 抢跑段（Tier1，上限 3）——标题已上移到折叠头，此处仅 hint + 满额徽章 + checkboxes */}
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <p className="text-xs text-muted-foreground">
              {t('settings.advanced.nodeResolverRaceHint')}
            </p>
            {tier1Full && (
              <Badge variant="secondary">{t('settings.advanced.nodeResolverTier1Full')}</Badge>
            )}
          </div>
          <div className="space-y-2">
            {tier1Items.map((it) => renderItem(it, { disabled: tier1Full }))}
          </div>
        </div>

        {/* 兜底段（Tier2，不占额度） */}
        <div className="space-y-2 border-t border-border/60 pt-3">
          <p className="text-sm font-medium text-foreground">
            {t('settings.advanced.nodeResolverFallbackHeading')}
          </p>
          <p className="text-xs text-muted-foreground">
            {t('settings.advanced.nodeResolverFallbackHint')}
          </p>
          <div className="space-y-2">{tier2Items.map((it) => renderItem(it, {}))}</div>
        </div>

        {/* 添加自定义上游（纯 IP，去重） */}
        <div className="flex items-center gap-2 border-t border-border/60 pt-3">
          <Input
            value={customSpec}
            onChange={(e) => setCustomSpec(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                addCustom();
              }
            }}
            placeholder={t('settings.advanced.nodeResolverCustomPlaceholder')}
            className="max-w-xs"
          />
          <Button size="sm" variant="outline" onClick={addCustom}>
            {t('settings.advanced.nodeResolverAddCustom')}
          </Button>
        </div>
      </div>
    </SettingsCollapsible>
  );
}
