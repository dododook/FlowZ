import { useState } from 'react';
import { Loader2, Cloud } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { api } from '@/ipc/api-client';
import { useTranslation } from 'react-i18next';

interface WarpPanelProps {
  /** 复用 dialog 的 handleSave：节点名由 dialog 名称字段提供（选 WARP 时已预填 Cloudflare WARP）。 */
  onSubmit: (config: any) => Promise<void>;
  /** dialog 名称是否为空——为空时禁用生成，避免「注册成功但 handleSave 因缺名 no-op」产生孤儿 WARP 设备。 */
  nameMissing: boolean;
}

/**
 * Cloudflare WARP「一键」面板——降低理解成本：用户无需懂 WireGuard，点一下即注册匿名设备并直接保存为
 * WireGuard 节点（不暴露 privateKey/reserved 等技术字段）。WARP+ license 可选（多数人用免费版）。
 * 生成的就是普通 WG 节点，后续可在「编辑」里查看/调整 AllowedIPs 等。
 *
 * Conduit 1:1 移植：改用原型设计系统类（`.field`/`.field-lbl`/`.input.mono`/`.btn.flow`）+ conduit token 提示框。
 * 注册/保存逻辑（api.server.registerWarp → onSubmit 构造普通 WireGuard 节点 + warpDevice 自删凭据）逐字保留。
 */
export function WarpPanel({ onSubmit, nameMissing }: WarpPanelProps) {
  const { t } = useTranslation();
  const [license, setLicense] = useState('');
  const [loading, setLoading] = useState(false);

  const handleGenerate = async () => {
    setLoading(true);
    try {
      const draft = await api.server.registerWarp(license.trim() || undefined);
      // 直接构造普通 WireGuard 节点并保存（dialog 成功后自动关闭）。
      await onSubmit({
        protocol: 'wireguard' as const,
        address: draft.address,
        port: draft.port,
        wireguardSettings: {
          privateKey: draft.privateKey,
          localAddress: draft.localAddress,
          peerPublicKey: draft.peerPublicKey,
          allowedIPs: draft.allowedIPs,
          // WARP 即全隧道隐私出口 → 默认允许访问外网（与 WG 缺省一致）。后续可在「编辑」(WG 表单) 里关闭/调整。
          allowInternet: true,
          persistentKeepalive: 25,
          mtu: draft.mtu,
          reserved: draft.reserved,
          // 不再丢弃注册产出的自删凭据：随节点落 wireguardSettings.warpDevice（与 privateKey 同脱敏），
          // 删除此节点时据它注销远端匿名设备（见 WARP 设计 §设备移除 / 方案 F）。保存路径不变，仍走 dialog handleSave。
          warpDevice: draft.warpDevice,
        },
      });
    } catch (e: any) {
      toast.error(`${t('servers.warpFailed', 'WARP registration failed')}: ${e?.message ?? e}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-3 rounded-[10px] border border-[hsl(var(--line))] bg-[hsl(var(--surface-2))] p-3">
        <Cloud className="mt-0.5 h-5 w-5 flex-shrink-0 text-[hsl(var(--fg-faint))]" />
        <p className="text-[12.5px] leading-relaxed text-[hsl(var(--fg-dim))]">
          {t(
            'servers.warpPanelIntro',
            'One click registers an anonymous Cloudflare WARP device and adds it as a node — no keys or settings to fill in. Edit it later to fine-tune routing.'
          )}
        </p>
      </div>

      {/* WARP+ license（可选）：默认可见——留空=免费版；填 license 则注册后直接应用为 WARP+。 */}
      <div className="field">
        <label className="field-lbl" htmlFor="warpLicenseKey">
          {t('servers.warpLicenseLabel', 'WARP+ license key (optional)')}
        </label>
        <input
          id="warpLicenseKey"
          className="input mono text-xs"
          placeholder={t('servers.warpLicense', 'WARP+ license key')}
          value={license}
          onChange={(e) => setLicense(e.target.value)}
        />
        <p className="text-[11px] text-[hsl(var(--fg-faint))]">
          {t(
            'servers.warpLicenseHint',
            'Leave empty for free WARP; enter a license to register as WARP+.'
          )}
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          onClick={handleGenerate}
          disabled={loading || nameMissing}
          className={cn(
            'btn flow self-start',
            (loading || nameMissing) && 'cursor-not-allowed opacity-60'
          )}
        >
          {loading && <Loader2 className="h-4 w-4 animate-spin" />}
          {t('servers.warpGenerateSave', 'Generate & Add WARP node')}
        </button>
        {nameMissing && (
          <p className="text-[11px] text-[hsl(var(--warn))]">
            {t('servers.warpNameFirst', 'Enter a node name above first')}
          </p>
        )}
      </div>
    </div>
  );
}
