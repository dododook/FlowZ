import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, Link, Server, Check, X, Edit2 } from 'lucide-react';
import { parseProtocolUrl, addServerFromUrl } from '@/bridge/api-wrapper';
import { isSupportedShareUrl } from '@shared/protocol-url-schemes';
import type { ServerConfig } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

interface ParsedServer {
  url: string;
  config: ServerConfig;
  name: string;
  error?: string;
}

interface ImportUrlDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImportSuccess?: () => void;
}

export function ImportUrlDialog({ open, onOpenChange, onImportSuccess }: ImportUrlDialogProps) {
  const { t } = useTranslation();
  const [url, setUrl] = useState('');
  const [parsedServers, setParsedServers] = useState<ParsedServer[]>([]);
  const [failedLines, setFailedLines] = useState<{ line: string; error: string }[]>([]);
  const [isParsing, setIsParsing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');

  const handleParseUrl = async () => {
    const input = url.trim();
    if (!input) {
      toast.error(t('importUrl.pleaseEnterUrl', 'Please enter a protocol URL'));
      return;
    }

    // 支持多行：按换行符分割
    const lines = input
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length === 0) {
      toast.error(t('importUrl.pleaseEnterUrl', 'Please enter a protocol URL'));
      return;
    }

    setIsParsing(true);
    const parsed: ParsedServer[] = [];
    const failed: { line: string; error: string }[] = [];

    for (const line of lines) {
      if (!isSupportedShareUrl(line)) {
        failed.push({ line, error: t('importUrl.invalidProtocol', 'Unsupported protocol') });
        continue;
      }

      try {
        const response = await parseProtocolUrl(line);
        if (response && response.success && response.data) {
          const config = response.data as ServerConfig;
          // 优先使用 URL 中解析出来的名称（#fragment）
          const name = config.name || `${config.protocol.toUpperCase()} - ${config.address}`;
          parsed.push({ url: line, config, name });
        } else {
          failed.push({
            line,
            error: response?.error || t('importUrl.parseFailed', 'URL parse failed'),
          });
        }
      } catch (error) {
        failed.push({
          line,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    setParsedServers(parsed);
    setFailedLines(failed);

    if (parsed.length > 0) {
      toast.success(
        t('importUrl.parseSuccessCount', {
          defaultValue: 'Successfully parsed {{count}} node(s)',
          count: parsed.length,
        })
      );
    }
    if (failed.length > 0) {
      toast.warning(
        t('importUrl.parseFailCount', {
          defaultValue: '{{count}} line(s) failed to parse',
          count: failed.length,
        })
      );
    }

    setIsParsing(false);
  };

  const handleImport = async () => {
    if (parsedServers.length === 0) {
      toast.error(t('importUrl.noNodesToImport', 'No nodes to import'));
      return;
    }

    setIsImporting(true);
    let successCount = 0;
    let failCount = 0;

    for (const server of parsedServers) {
      try {
        const response = await addServerFromUrl(server.url, server.name);
        if (response && response.success) {
          successCount++;
        } else {
          failCount++;
        }
      } catch {
        failCount++;
      }
    }

    if (successCount > 0) {
      toast.success(
        t('importUrl.importSuccessCount', {
          defaultValue: 'Successfully imported {{count}} node(s)',
          count: successCount,
        })
      );
      onImportSuccess?.();
    }
    if (failCount > 0) {
      toast.error(
        t('importUrl.importFailCount', {
          defaultValue: '{{count}} node(s) failed to import',
          count: failCount,
        })
      );
    }

    setIsImporting(false);
    handleClose();
  };

  const handleClose = () => {
    setUrl('');
    setParsedServers([]);
    setFailedLines([]);
    setEditingIndex(null);
    onOpenChange(false);
  };

  const handleRemoveServer = (index: number) => {
    setParsedServers((prev) => prev.filter((_, i) => i !== index));
  };

  const handleStartEditName = (index: number) => {
    setEditingIndex(index);
    setEditingName(parsedServers[index].name);
  };

  const handleSaveEditName = (index: number) => {
    if (editingName.trim()) {
      setParsedServers((prev) =>
        prev.map((s, i) => (i === index ? { ...s, name: editingName.trim() } : s))
      );
    }
    setEditingIndex(null);
  };

  const hasAnyValidUrl = url.split(/\r?\n/).some((l) => isSupportedShareUrl(l.trim()));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link className="h-5 w-5" />
            {t('importUrl.title', 'Import Server from URL')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'importUrl.desc',
              'Supports common protocol links; paste multiple lines for batch import.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="protocol-url">{t('importUrl.urlLabel', 'Protocol URL')}</Label>
            <div className="flex gap-2">
              <Textarea
                id="protocol-url"
                placeholder={t(
                  'importUrl.urlPlaceholder',
                  'vmess://base64(json)\nor vless://uuid@server:port?security=tls#name\nor ss://base64(method:password)@server:port#name\n\n…paste multiple lines, one link per line'
                )}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                className="min-h-[100px] resize-none"
              />
              <Button
                onClick={handleParseUrl}
                disabled={!url.trim() || !hasAnyValidUrl || isParsing}
                className="shrink-0"
              >
                {isParsing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  t('importUrl.parse', 'Parse')
                )}
              </Button>
            </div>
          </div>

          {/* 解析成功的节点列表 */}
          {parsedServers.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Server className="h-4 w-4" />
                  {t('importUrl.parseResult', 'Parse Result')}
                  <Badge variant="secondary" className="ms-1">
                    {parsedServers.length}
                  </Badge>
                </CardTitle>
                <CardDescription>
                  {t('importUrl.parseResultDesc', 'Click the edit icon to rename a node')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {parsedServers.map((server, index) => (
                  <div
                    key={index}
                    className="flex items-center gap-2 p-2 rounded-md border bg-muted/30 hover:bg-muted/50 transition-colors"
                  >
                    <Badge variant="outline" className="shrink-0 text-xs">
                      {server.config.protocol.toUpperCase()}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      {editingIndex === index ? (
                        <div className="flex items-center gap-1">
                          <Input
                            value={editingName}
                            onChange={(e) => setEditingName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') handleSaveEditName(index);
                              if (e.key === 'Escape') setEditingIndex(null);
                            }}
                            className="h-7 text-sm"
                            autoFocus
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 shrink-0"
                            onClick={() => handleSaveEditName(index)}
                          >
                            <Check className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1">
                          <span className="text-sm font-medium truncate">{server.name}</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 shrink-0 opacity-50 hover:opacity-100"
                            onClick={() => handleStartEditName(index)}
                          >
                            <Edit2 className="h-3 w-3" />
                          </Button>
                        </div>
                      )}
                      <span className="text-xs text-muted-foreground">
                        {server.config.address}:{server.config.port}
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 shrink-0 text-destructive hover:text-destructive"
                      onClick={() => handleRemoveServer(index)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* 解析失败的行 */}
          {failedLines.length > 0 && (
            <Card className="border-destructive/30">
              <CardHeader className="pb-3">
                <CardTitle className="text-base text-destructive flex items-center gap-2">
                  <X className="h-4 w-4" />
                  {t('importUrl.parseFailed', 'Parse Failed')}
                  <Badge variant="destructive" className="ms-1">
                    {failedLines.length}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-1">
                {failedLines.map((item, index) => (
                  <div key={index} className="text-xs text-muted-foreground">
                    <span className="font-mono truncate block">
                      {item.line.substring(0, 60)}...
                    </span>
                    <span className="text-destructive">{item.error}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button onClick={handleImport} disabled={parsedServers.length === 0 || isImporting}>
            {isImporting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin me-2" />
                {t('importUrl.importing', 'Importing...')}
              </>
            ) : parsedServers.length > 1 ? (
              t('importUrl.importCount', {
                defaultValue: 'Import {{count}} nodes',
                count: parsedServers.length,
              })
            ) : (
              t('importUrl.importServer', 'Import Server')
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
