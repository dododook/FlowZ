import { useEffect, useState, useRef } from 'react';
import { Loader2, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { FormSection } from './shared/form-layout';
import { InfoTooltip } from './shared/info-tooltip';
import { splitTextList } from './shared/parse-list';
import { api } from '@/ipc/api-client';
import type { ServerConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

interface CustomFormProps {
  serverConfig?: ServerConfig;
  onSubmit: (config: any) => Promise<void>;
}

const PLACEHOLDER = `{
  "type": "snell",
  "server": "1.2.3.4",
  "server_port": 8388,
  "psk": "your-psk",
  "version": 4
}`;

type ProbeState = { state: 'idle' | 'checking' | 'ok' | 'fail' | 'unknown'; error?: string };

/** 解析为合法的 outbound 对象（对象 + 含字符串 type）；否则 null。 */
const parseOutbound = (text: string): Record<string, unknown> | null => {
  try {
    const o = JSON.parse(text);
    if (
      o &&
      typeof o === 'object' &&
      !Array.isArray(o) &&
      typeof o.type === 'string' &&
      o.type.trim()
    ) {
      return o as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
};

/**
 * 自定义协议（raw-JSON 透传）表单：用户直接填一份 sing-box outbound/endpoint JSON。
 * 「内核即权威」——填写后实时（防抖）调主进程 probe（sing-box check）显示当前内核是否兼容；
 * 即使不兼容也允许保存（留待切换第三方内核），仅给✗与原因。tag 在生成期由后端强制注入。
 */
export function CustomForm({ serverConfig, onSubmit }: CustomFormProps) {
  const { t } = useTranslation();
  const [jsonText, setJsonText] = useState('');
  const [isEndpoint, setIsEndpoint] = useState(false);
  const [secretKeys, setSecretKeys] = useState('');
  const [jsonError, setJsonError] = useState('');
  const [probe, setProbe] = useState<ProbeState>({ state: 'idle' });
  const [submitting, setSubmitting] = useState(false);
  const probeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const probeSeq = useRef(0); // 防竞态：仅最新一次 probe 的结果可写入显示，旧的慢响应丢弃

  useEffect(() => {
    if (serverConfig && serverConfig.protocol?.toLowerCase() === 'custom') {
      const cs = serverConfig.customSettings;
      setJsonText(cs?.outbound ? JSON.stringify(cs.outbound, null, 2) : '');
      setIsEndpoint(!!cs?.isEndpoint);
      setSecretKeys((cs?.secretKeys || []).join(', '));
    }
  }, [serverConfig]);

  // 输入防抖 probe：解析失败只提示 JSON 非法、不 probe；解析成功 → 500ms 后异步 probe 当前内核兼容性。
  useEffect(() => {
    if (probeTimer.current) clearTimeout(probeTimer.current);
    if (!jsonText.trim()) {
      setJsonError('');
      setProbe({ state: 'idle' });
      return;
    }
    const o = parseOutbound(jsonText);
    if (!o) {
      setJsonError(
        t('servers.customJsonInvalid', 'Invalid JSON — must be an object with a "type" field')
      );
      setProbe({ state: 'idle' });
      return;
    }
    setJsonError('');
    setProbe({ state: 'checking' });
    const seq = ++probeSeq.current;
    probeTimer.current = setTimeout(() => {
      void api.proxy.probeOutbound(o, isEndpoint).then((r) => {
        if (seq !== probeSeq.current) return; // 已被更新的输入取代，丢弃这次（旧）结果
        if (r.ok) setProbe({ state: 'ok' });
        else if (r.indeterminate) setProbe({ state: 'unknown', error: r.error });
        else setProbe({ state: 'fail', error: r.error });
      });
    }, 500);
    return () => {
      if (probeTimer.current) clearTimeout(probeTimer.current);
    };
  }, [jsonText, isEndpoint, t]);

  const handleSubmit = async () => {
    const o = parseOutbound(jsonText);
    if (!o) {
      setJsonError(
        t('servers.customJsonInvalid', 'Invalid JSON — must be an object with a "type" field')
      );
      return;
    }
    setSubmitting(true);
    try {
      // address/port 仅供列表展示（自定义协议的真实 server/port 在 JSON 内）；从 JSON 提取常见键，缺则空。
      await onSubmit({
        protocol: 'custom' as const,
        address: typeof o.server === 'string' ? o.server : '',
        port: typeof o.server_port === 'number' ? o.server_port : 0,
        customSettings: {
          outbound: o,
          isEndpoint,
          secretKeys: splitTextList(secretKeys),
        },
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex flex-col gap-[13px]">
      <div className="nd-fld">
        <span className="nd-fld-lbl inline-flex items-center gap-1.5">
          {t('servers.customIntro', 'Paste a raw sing-box outbound JSON (e.g. snell).')}
          <span className="nd-req">*</span>
          <InfoTooltip content={t('servers.customIntroFull')} />
        </span>
        <textarea
          className="nd-textarea"
          style={{ minHeight: 130 }}
          placeholder={PLACEHOLDER}
          value={jsonText}
          onChange={(e) => setJsonText(e.target.value)}
        />
        {jsonError ? (
          <p className="fld-err">{jsonError}</p>
        ) : (
          <div className="flex items-start gap-1.5 text-xs">
            {probe.state === 'checking' && (
              <>
                <Loader2 className="mt-0.5 h-3.5 w-3.5 animate-spin text-muted-foreground" />
                <span className="text-muted-foreground">
                  {t('servers.customProbing', 'Checking kernel compatibility…')}
                </span>
              </>
            )}
            {probe.state === 'ok' && (
              <>
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 text-success" />
                <span className="text-success">
                  {t('servers.customCompatible', 'Compatible with the current kernel')}
                </span>
              </>
            )}
            {probe.state === 'fail' && (
              <>
                <XCircle className="mt-0.5 h-3.5 w-3.5 text-destructive" />
                <span className="text-destructive">
                  {t(
                    'servers.customIncompatible',
                    'Not supported by the current kernel (needs a compatible third-party kernel)'
                  )}
                  {probe.error ? `: ${probe.error}` : ''}
                </span>
              </>
            )}
            {probe.state === 'unknown' && (
              <>
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 text-amber-500" />
                <span className="text-amber-600 dark:text-amber-500">
                  {t('servers.customIndeterminate', 'Could not determine compatibility')}
                  {probe.error ? `: ${probe.error}` : ''}
                </span>
              </>
            )}
          </div>
        )}
      </div>

      <FormSection title={t('servers.advanced', 'Advanced')} collapsible defaultOpen={false}>
        <div className="nd-swrow">
          <div className="nd-swrow-main">
            <div className="nd-swrow-t inline-flex items-center gap-1.5">
              {t('servers.customIsEndpoint', 'Endpoint type')}
              <InfoTooltip
                content={t(
                  'servers.customIsEndpointDesc',
                  'Enable if this type belongs to sing-box endpoints[] (wireguard/tailscale-like) instead of outbounds[].'
                )}
              />
            </div>
          </div>
          <Switch checked={isEndpoint} onCheckedChange={setIsEndpoint} />
        </div>
        <div className="nd-fld">
          <span className="nd-fld-lbl">
            {t('servers.customSecretKeys', 'Secret field names (optional)')}
          </span>
          <Input
            placeholder="password, psk, uuid"
            value={secretKeys}
            onChange={(e) => setSecretKeys(e.target.value)}
          />
        </div>
      </FormSection>

      <div className="flex gap-4">
        <Button type="button" onClick={handleSubmit} disabled={submitting || !!jsonError}>
          {submitting && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}
