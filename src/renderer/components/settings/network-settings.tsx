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
import { parseSpeedTestUrl, DEFAULT_SPEED_TEST_URL } from '@shared/speed-test';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { SettingsRow } from './settings-row';
import { HelperManagementCard } from './helper-management-card';

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

  const [socksPort, setSocksPort] = useState(config?.socksPort?.toString() || '2081');
  const [httpPort, setHttpPort] = useState(config?.httpPort?.toString() || '2080');
  const [mixedPortEnabled, setMixedPortEnabled] = useState((config?.mixedPort ?? 0) > 0);
  const [mixedPort, setMixedPort] = useState(
    config?.mixedPort && config.mixedPort > 0 ? config.mixedPort.toString() : '7890'
  );
  const [isLoading, setIsLoading] = useState(false);
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
    socksPort: string;
    httpPort: string;
    mixedPortEnabled: boolean;
    mixedPort: string;
    subInterval: string;
    domesticDns: string;
    foreignDns: string;
    speedTestUrl: string;
  } | null>(null);
  useEffect(() => {
    if (!config) return;
    const snap = {
      socksPort: config.socksPort?.toString() || '2081',
      httpPort: config.httpPort?.toString() || '2080',
      mixedPortEnabled: (config.mixedPort ?? 0) > 0,
      mixedPort: config.mixedPort && config.mixedPort > 0 ? config.mixedPort.toString() : '7890',
      subInterval: config.subscriptionUpdateIntervalHours?.toString() || '12',
      domesticDns: config.dnsConfig?.domesticDns || DNS_DEFAULTS.domesticDns,
      foreignDns: config.dnsConfig?.foreignDns || DNS_DEFAULTS.foreignDns,
      speedTestUrl: config.speedTestUrl || DEFAULT_SPEED_TEST_URL,
    };
    const prev = seededRef.current;
    setSocksPort((cur) => (prev && cur !== prev.socksPort ? cur : snap.socksPort));
    setHttpPort((cur) => (prev && cur !== prev.httpPort ? cur : snap.httpPort));
    setMixedPortEnabled((cur) =>
      prev && cur !== prev.mixedPortEnabled ? cur : snap.mixedPortEnabled
    );
    setMixedPort((cur) => (prev && cur !== prev.mixedPort ? cur : snap.mixedPort));
    setSubInterval((cur) => (prev && cur !== prev.subInterval ? cur : snap.subInterval));
    setDomesticDns((cur) => (prev && cur !== prev.domesticDns ? cur : snap.domesticDns));
    setForeignDns((cur) => (prev && cur !== prev.foreignDns ? cur : snap.foreignDns));
    setSpeedTestUrl((cur) => (prev && cur !== prev.speedTestUrl ? cur : snap.speedTestUrl));
    seededRef.current = snap;
  }, [
    config?.socksPort,
    config?.httpPort,
    config?.mixedPort,
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

  const handleSavePorts = async () => {
    const socksPortNum = parseInt(socksPort, 10);
    const httpPortNum = parseInt(httpPort, 10);
    if (isNaN(socksPortNum) || socksPortNum < 1024 || socksPortNum > 65535) {
      toast.error(t('settings.advanced.socksPortRange'));
      return;
    }
    if (isNaN(httpPortNum) || httpPortNum < 1024 || httpPortNum > 65535) {
      toast.error(t('settings.advanced.httpPortRange'));
      return;
    }
    if (socksPortNum === httpPortNum) {
      toast.error(t('settings.advanced.portsSame'));
      return;
    }
    let mixedPortNum: number | undefined = undefined;
    if (mixedPortEnabled) {
      mixedPortNum = parseInt(mixedPort, 10);
      if (isNaN(mixedPortNum) || mixedPortNum < 1024 || mixedPortNum > 65535) {
        toast.error(t('settings.advanced.mixedPortRange'));
        return;
      }
      if (mixedPortNum === socksPortNum || mixedPortNum === httpPortNum) {
        toast.error(t('settings.advanced.mixedPortConflict'));
        return;
      }
    }
    setIsLoading(true);
    try {
      await saveConfig({
        ...config,
        socksPort: socksPortNum,
        httpPort: httpPortNum,
        mixedPort: mixedPortEnabled ? mixedPortNum : 0,
      });
      toast.success(t('settings.advanced.portsSaved'));
    } catch {
      toast.error(t('settings.advanced.portsSaveFail'));
    } finally {
      setIsLoading(false);
    }
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
          <SettingsRow
            label={t('settings.advanced.fakeIpFilter', 'fake-ip-filter 默认清单')}
            description={t(
              'settings.advanced.fakeIpFilterDesc',
              'NTP / STUN / 连通性探测等域名走真实 DNS 解析、绕过 FakeIP（避免校时失败、系统误判断网 / 锁屏登录卡死）。建议开启。'
            )}
          >
            <Switch
              checked={config.fakeIpFilter !== false}
              onCheckedChange={(c) => setBool('fakeIpFilter', c)}
            />
          </SettingsRow>
          <SettingsRow
            label={t('settings.advanced.nodeDomainResolver')}
            description={t('settings.advanced.nodeDomainResolverDesc')}
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
                <SelectItem value="dnspod">{t('settings.advanced.nodeResolverDnspod')}</SelectItem>
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
            label={t('settings.advanced.mainSessionViaProxy', '更新检查走代理')}
            description={t(
              'settings.advanced.mainSessionViaProxyDesc',
              '开启后，应用/内核更新检查与规则资源下载在代理运行时经代理（更新源多在 GitHub）；关闭则直连/走系统代理。注：TUN 模式下因系统层捕获，关闭不能完全直连。'
            )}
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
        </CardContent>
      </Card>

      {/* 端口 */}
      <Card>
        <CardContent className="divide-y divide-border/60 pt-2">
          <SettingsRow heading label={t('settings.advanced.portSettings')} />
          <SettingsRow
            label={t('settings.advanced.socksPort')}
            description={`${t('settings.advanced.default')}: 2081`}
          >
            {numInput(socksPort, setSocksPort)}
          </SettingsRow>
          <SettingsRow
            label={t('settings.advanced.httpPort')}
            description={`${t('settings.advanced.default')}: 2080`}
          >
            {numInput(httpPort, setHttpPort)}
          </SettingsRow>
          <SettingsRow
            label={t('settings.advanced.mixedPort')}
            description={t('settings.advanced.mixedPortDesc')}
          >
            <Switch checked={mixedPortEnabled} onCheckedChange={setMixedPortEnabled} />
          </SettingsRow>
          {mixedPortEnabled && (
            <SettingsRow
              label={t('settings.advanced.mixedPortValue')}
              description={`${t('settings.advanced.default')}: 7890`}
            >
              {numInput(mixedPort, setMixedPort)}
            </SettingsRow>
          )}
          <div className="pt-3">
            <Button onClick={handleSavePorts} disabled={isLoading}>
              {isLoading ? t('settings.advanced.saving') : t('settings.advanced.savePortSettings')}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* 连接（原「局域网设置」杂烩去杂、归位） */}
      <Card>
        <CardContent className="divide-y divide-border/60 pt-2">
          <SettingsRow heading label={t('settings.network.connection')} />
          <SettingsRow
            label={t('settings.advanced.allowLan')}
            description={t('settings.advanced.allowLanDesc')}
          >
            <Switch
              checked={config.allowLan === true}
              onCheckedChange={(c) => setBool('allowLan', c)}
            />
          </SettingsRow>
          {config.allowLan && (
            <p className="py-2 text-xs font-medium text-warning">
              {t('settings.advanced.allowLanGatewayTip')}
            </p>
          )}
          <SettingsRow
            label={t('settings.advanced.bypassLAN')}
            description={t('settings.advanced.bypassLANDesc')}
          >
            <Switch
              checked={config.bypassLAN !== false}
              onCheckedChange={(c) => setBool('bypassLAN', c)}
            />
          </SettingsRow>
          <SettingsRow
            label={t('settings.advanced.blockQuic')}
            description={t('settings.advanced.blockQuicDesc')}
          >
            <Switch
              checked={config.blockQuic === true}
              onCheckedChange={(c) => setBool('blockQuic', c)}
            />
          </SettingsRow>
          <SettingsRow
            label={t('settings.advanced.interruptOnSwitch')}
            description={t('settings.advanced.interruptOnSwitchDesc')}
          >
            <Switch
              checked={config.interruptConnectionsOnSwitch === true}
              onCheckedChange={(c) => setBool('interruptConnectionsOnSwitch', c)}
            />
          </SettingsRow>
          <SettingsRow
            label={t('settings.advanced.tlsFragment')}
            description={t('settings.advanced.tlsFragmentDesc')}
          >
            <Switch
              checked={config.tlsFragment === true}
              onCheckedChange={(c) => setBool('tlsFragment', c)}
            />
          </SettingsRow>
          <SettingsRow
            label={t('settings.advanced.autoSwitchNode')}
            description={t('settings.advanced.autoSwitchNodeDesc')}
          >
            <Switch
              checked={config.autoSwitchNode === true}
              onCheckedChange={(c) => setBool('autoSwitchNode', c)}
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
        </CardContent>
      </Card>

      {/* 节点测速 */}
      <Card>
        <CardContent className="divide-y divide-border/60 pt-2">
          <SettingsRow heading label={t('settings.network.speedTest')} />
          <SettingsRow
            label={t('settings.network.speedTestUrl')}
            description={t('settings.network.speedTestUrlDesc')}
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

      {/* 订阅自动更新 */}
      <Card>
        <CardContent className="divide-y divide-border/60 pt-2">
          <SettingsRow heading label={t('settings.advanced.subAutoUpdate')} />
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
              >
                <Switch
                  checked={config.subscriptionUpdateViaProxy === true}
                  onCheckedChange={(c) => setBool('subscriptionUpdateViaProxy', c)}
                />
              </SettingsRow>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
