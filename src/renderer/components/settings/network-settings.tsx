import { useState, useEffect, useRef } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
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
import { controlApiPort } from '@shared/proxy-ports';
import { DEFAULT_BYPASS_LAN } from '@shared/system-proxy-bypass';
import { parseSpeedTestUrl, DEFAULT_SPEED_TEST_URL } from '@shared/speed-test';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { SettingsRow } from './settings-row';
import { SettingsCollapsible } from './settings-collapsible';
import { ExceptionList } from './exception-list';
import { DEFAULT_FAKEIP_FILTER_DOMAINS } from '../../../shared/fakeip-filter';
import { HelperManagementCard } from './helper-management-card';
import { ExternalControlSection } from './external-control-section';
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
  // clash_api 外部控制端口（默认 9090，可改以解端口冲突死局）。失焦提交，外部变更时 resync。
  const [controlPort, setControlPort] = useState(controlApiPort(config ?? {}).toString());
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

  // F26：config 异步到达 / 挂载期间被外部替换（托盘改配置、备份恢复、规则 CRUD 后 loadConfig）时，
  // 回填「未被用户改动」的字段；dirty 守卫（本地值 ≠ 上次种子）避免打断正在输入的用户。
  const seededRef = useRef<{
    localPort: string;
    controlPort: string;
    subInterval: string;
    domesticDns: string;
    foreignDns: string;
    speedTestUrl: string;
  } | null>(null);
  useEffect(() => {
    if (!config) return;
    const snap = {
      localPort: (config.mixedPort || config.httpPort || 7890).toString(),
      controlPort: controlApiPort(config).toString(),
      subInterval: config.subscriptionUpdateIntervalHours?.toString() || '12',
      domesticDns: config.dnsConfig?.domesticDns || DNS_DEFAULTS.domesticDns,
      foreignDns: config.dnsConfig?.foreignDns || DNS_DEFAULTS.foreignDns,
      speedTestUrl: config.speedTestUrl || DEFAULT_SPEED_TEST_URL,
    };
    const prev = seededRef.current;
    setLocalPort((cur) => (prev && cur !== prev.localPort ? cur : snap.localPort));
    setControlPort((cur) => (prev && cur !== prev.controlPort ? cur : snap.controlPort));
    setSubInterval((cur) => (prev && cur !== prev.subInterval ? cur : snap.subInterval));
    setDomesticDns((cur) => (prev && cur !== prev.domesticDns ? cur : snap.domesticDns));
    setForeignDns((cur) => (prev && cur !== prev.foreignDns ? cur : snap.foreignDns));
    setSpeedTestUrl((cur) => (prev && cur !== prev.speedTestUrl ? cur : snap.speedTestUrl));
    seededRef.current = snap;
  }, [
    config?.mixedPort,
    config?.httpPort,
    config?.controlPort,
    config?.subscriptionUpdateIntervalHours,
    config?.dnsConfig?.domesticDns,
    config?.dnsConfig?.foreignDns,
    config?.speedTestUrl,
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
    if (portNum === controlApiPort(config)) {
      // 撞控制端口（clash_api）→ sing-box 两 inbound 同口必 FATAL。两者皆可改，提示改其一并回滚。
      toast.error(
        t('settings.advanced.portClashWithControl', '本地端口不能与控制端口相同，请改其中之一')
      );
      revert();
      return;
    }
    if (portNum === cur) return; // 无变化
    setLocalPort(portNum.toString());
    saveConfig({ ...config, mixedPort: portNum }).catch(() => toast.error(t('common.saveFailed')));
  };

  // 控制端口（clash_api external_controller）：失焦即生效。范围/与本地端口冲突给提示并回滚。
  const commitControlPort = () => {
    const portNum = parseInt(controlPort, 10);
    const cur = controlApiPort(config);
    const revert = () => setControlPort(cur.toString());
    if (isNaN(portNum) || portNum < 1024 || portNum > 65535) {
      toast.error(t('settings.advanced.localPortRange', '端口须为 1024-65535'));
      revert();
      return;
    }
    if (portNum === (config.mixedPort || config.httpPort || 7890)) {
      toast.error(
        t('settings.advanced.portClashWithControl', '本地端口不能与控制端口相同，请改其中之一')
      );
      revert();
      return;
    }
    if (portNum === cur) return; // 无变化
    setControlPort(portNum.toString());
    saveConfig({ ...config, controlPort: portNum }).catch(() =>
      toast.error(t('common.saveFailed'))
    );
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
            <SettingsRow
              label={t('settings.advanced.nodeDomainResolver')}
              description={t('settings.advanced.nodeDomainResolverDesc')}
              tooltip={t('settings.advanced.nodeDomainResolverDescFull')}
            >
              <Select
                value={config.dnsConfig?.nodeDomainResolver ?? 'auto'}
                onValueChange={(v) =>
                  updateDns({
                    nodeDomainResolver: v as NonNullable<
                      typeof config.dnsConfig
                    >['nodeDomainResolver'],
                  })
                }
              >
                <SelectTrigger className="h-8 w-[160px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t('settings.advanced.nodeResolverAuto')}</SelectItem>
                  <SelectItem value="dnspod">
                    {t('settings.advanced.nodeResolverDnspod')}
                  </SelectItem>
                  <SelectItem value="system">
                    {t('settings.advanced.nodeResolverSystem')}
                    {isLinux && config.proxyModeType === 'tun'
                      ? ` (${t('settings.advanced.nodeResolverExperimental')})`
                      : ''}
                  </SelectItem>
                </SelectContent>
              </Select>
            </SettingsRow>
            <SettingsRow
              label={t('settings.advanced.resolveNodeDomainsAhead', '节点域名解析前置')}
              description={t('settings.advanced.resolveNodeDomainsAheadDesc')}
              tooltip={t('settings.advanced.resolveNodeDomainsAheadDescFull')}
            >
              <Switch
                checked={config.dnsConfig?.resolveNodeDomainsAhead !== false}
                onCheckedChange={(c) => updateDns({ resolveNodeDomainsAhead: c })}
              />
            </SettingsRow>
            <SettingsRow
              label={t('settings.advanced.takeoverSystemDns', 'TUN 接管系统 DNS')}
              description={t('settings.advanced.takeoverSystemDnsDesc')}
              tooltip={t('settings.advanced.takeoverSystemDnsDescFull')}
            >
              <Switch
                checked={config.dnsConfig?.takeoverSystemDns !== false}
                onCheckedChange={(c) => updateDns({ takeoverSystemDns: c })}
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
          <SettingsRow
            label={t('settings.advanced.controlPort', '控制端口')}
            description={t('settings.advanced.controlPortDesc')}
            tooltip={t('settings.advanced.controlPortDescFull')}
          >
            {numInput(controlPort, setControlPort, 'w-[120px]', commitControlPort)}
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
        </CardContent>
      </Card>

      {/* 外部控制 / clash API（从「高级」节迁入，与控制端口同节就近，M2） */}
      <Card>
        <CardContent className="divide-y divide-border/60 pt-2">
          <ExternalControlSection />
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
