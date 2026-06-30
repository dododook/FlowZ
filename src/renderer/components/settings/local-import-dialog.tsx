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
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Loader2, HardDriveDownload, Server, Rss, Check, X, Edit2, FileText } from 'lucide-react';
import { api } from '@/ipc/api-client';
import type { ServerConfig, ImportParseResult } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

interface LocalImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImportSuccess?: () => void;
}

export function LocalImportDialog({ open, onOpenChange, onImportSuccess }: LocalImportDialogProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'file' | 'text'>('file');
  const [content, setContent] = useState('');
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ImportParseResult | null>(null);
  const [nodes, setNodes] = useState<ServerConfig[]>([]);
  const [subs, setSubs] = useState<{ name: string; url: string }[]>([]);
  const [isParsing, setIsParsing] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [editingName, setEditingName] = useState('');

  const resetResult = () => {
    setParsed(null);
    setNodes([]);
    setSubs([]);
    setEditingIndex(null);
  };

  const handleFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      toast.error(t('localImport.errTooLarge', 'File too large (max 10 MB)'));
      return;
    }
    try {
      const text = await file.text();
      setContent(text);
      setFileName(file.name);
      resetResult();
    } catch {
      toast.error(t('localImport.errRead', 'Failed to read file, please retry'));
    }
  };

  const handleParse = async () => {
    const text = content.trim();
    if (!text) {
      toast.error(t('localImport.errEmptyInput', 'Please select a file or paste content'));
      return;
    }
    if (text.length > 10 * 1024 * 1024) {
      toast.error(t('localImport.errTooLarge', 'File too large (max 10 MB)'));
      return;
    }
    setIsParsing(true);
    try {
      const result = await api.localImport.parse(text);
      setParsed(result);
      setNodes(result.nodes);
      setSubs(result.subscriptions);
      setEditingIndex(null);
      if (result.nodes.length === 0 && result.subscriptions.length === 0) {
        toast.warning(t('localImport.errEmpty', 'No usable nodes found'));
      } else {
        toast.success(
          t('localImport.parsed', {
            defaultValue: 'Parsed {{nodes}} node(s), {{subs}} subscription(s)',
            nodes: result.nodes.length,
            subs: result.subscriptions.length,
          })
        );
      }
    } catch {
      // 主进程对不可识别格式 throw → 门控报错
      toast.error(
        t(
          'localImport.errFormat',
          'Unrecognized format. Expect a sing-box / Xray / Clash config or valid share links.'
        )
      );
    } finally {
      setIsParsing(false);
    }
  };

  const handleImport = async () => {
    if (nodes.length === 0 && subs.length === 0) return;
    setIsImporting(true);
    try {
      let added = 0;
      if (nodes.length > 0) {
        const r = await api.server.addBulk(nodes);
        added = r.added;
      }
      let addedSubs = 0;
      for (const s of subs) {
        try {
          await api.subscription.add({
            name: s.name,
            url: s.url,
            autoUpdate: false,
            updateViaProxy: false,
          });
          addedSubs++;
        } catch {
          /* 单条订阅失败不阻断其余 */
        }
      }

      toast.success(
        t('localImport.resultOk', {
          defaultValue: 'Imported {{imported}} node(s), {{subs}} subscription(s)',
          imported: added,
          subs: addedSubs,
        })
      );
      // 用实际将导入的节点统计（用户可能在预览里删过 custom 节点），不用解析时的固定值。
      const unsupported = nodes.filter((n) => n.protocol === 'custom').length;
      if (unsupported > 0) {
        toast.warning(
          t('localImport.resultUnsupported', {
            defaultValue: '{{count}} node(s) use protocols unsupported by the core and are dimmed',
            count: unsupported,
          })
        );
      }
      const dropped = (parsed?.stats.skipped ?? 0) + (parsed?.stats.failed ?? 0);
      if (dropped > 0) {
        toast.warning(
          t('localImport.resultSkipped', {
            defaultValue: '{{count}} node(s) failed to parse and were skipped',
            count: dropped,
          })
        );
      }
      onImportSuccess?.();
      handleClose();
    } catch {
      toast.error(t('localImport.importFailed', 'Import failed'));
    } finally {
      setIsImporting(false);
    }
  };

  const handleClose = () => {
    setContent('');
    setFileName('');
    resetResult();
    setTab('file');
    onOpenChange(false);
  };

  const removeNode = (index: number) => setNodes((prev) => prev.filter((_, i) => i !== index));
  const removeSub = (index: number) => setSubs((prev) => prev.filter((_, i) => i !== index));

  const startEdit = (index: number) => {
    setEditingIndex(index);
    setEditingName(nodes[index].name);
  };
  const saveEdit = (index: number) => {
    if (editingName.trim()) {
      setNodes((prev) =>
        prev.map((n, i) => (i === index ? { ...n, name: editingName.trim() } : n))
      );
    }
    setEditingIndex(null);
  };

  const total = nodes.length + subs.length;
  const dropped = (parsed?.stats.skipped ?? 0) + (parsed?.stats.failed ?? 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HardDriveDownload className="h-5 w-5" />
            {t('localImport.title', 'Manual Import')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'localImport.desc',
              'Supports sing-box / Xray (.json) and Clash (.yaml), plus share links / Base64 text. Nodes go to Manual; Clash subscription sources become subscriptions.'
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <Tabs value={tab} onValueChange={(v) => setTab(v as 'file' | 'text')}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="file">{t('localImport.tabFile', 'Select File')}</TabsTrigger>
              <TabsTrigger value="text">{t('localImport.tabText', 'Paste Text')}</TabsTrigger>
            </TabsList>

            <TabsContent value="file" className="space-y-2">
              <Label htmlFor="local-import-file">{t('localImport.fileLabel', 'Config File')}</Label>
              <Input
                id="local-import-file"
                type="file"
                accept=".json,.yaml,.yml,.txt,.conf"
                onChange={handleFile}
              />
              {fileName && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <FileText className="h-3.5 w-3.5" />
                  {fileName}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {t('localImport.fileHint', 'Pick a .json / .yaml / .txt file')}
              </p>
            </TabsContent>

            <TabsContent value="text" className="space-y-2">
              <Label htmlFor="local-import-text">{t('localImport.textLabel', 'Content')}</Label>
              <Textarea
                id="local-import-text"
                placeholder={t(
                  'localImport.textPlaceholder',
                  'Paste Base64 subscription content, or one share link per line (vmess:// vless:// ss:// …)'
                )}
                value={content}
                onChange={(e) => {
                  setContent(e.target.value);
                  setFileName('');
                  resetResult();
                }}
                className="min-h-[120px] resize-none font-mono text-xs"
              />
            </TabsContent>
          </Tabs>

          <Button onClick={handleParse} disabled={!content.trim() || isParsing} className="w-full">
            {isParsing ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              t('localImport.parse', 'Parse')
            )}
          </Button>

          {/* 节点预览 */}
          {nodes.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Server className="h-4 w-4" />
                  {t('localImport.nodesTitle', 'Nodes to import')}
                  <Badge variant="secondary" className="ms-1">
                    {nodes.length}
                  </Badge>
                </CardTitle>
                <CardDescription>
                  {t('localImport.nodesDesc', 'Click the edit icon to rename a node')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {nodes.map((node, index) => (
                  <div
                    key={node.id}
                    className="flex items-center gap-2 p-2 rounded-md border bg-muted/30 hover:bg-muted/50 transition-colors"
                  >
                    <Badge variant="outline" className="shrink-0 text-xs">
                      {node.protocol.toUpperCase()}
                    </Badge>
                    {node.protocol === 'custom' && (
                      <Badge
                        variant="destructive"
                        className="shrink-0 text-xs"
                        title={t(
                          'localImport.unsupportedTip',
                          'Protocol not supported by the current core; dimmed after import, but editable/deletable'
                        )}
                      >
                        {t('localImport.unsupportedBadge', 'Unsupported')}
                      </Badge>
                    )}
                    <div className="flex-1 min-w-0">
                      {editingIndex === index ? (
                        <div className="flex items-center gap-1">
                          <Input
                            value={editingName}
                            onChange={(e) => setEditingName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') saveEdit(index);
                              if (e.key === 'Escape') setEditingIndex(null);
                            }}
                            className="h-7 text-sm"
                            autoFocus
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 w-7 p-0 shrink-0"
                            onClick={() => saveEdit(index)}
                          >
                            <Check className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1">
                          <span className="text-sm font-medium truncate">{node.name}</span>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-6 w-6 p-0 shrink-0 opacity-50 hover:opacity-100"
                            onClick={() => startEdit(index)}
                          >
                            <Edit2 className="h-3 w-3" />
                          </Button>
                        </div>
                      )}
                      {node.address ? (
                        <span className="text-xs text-muted-foreground">
                          {node.address}:{node.port}
                        </span>
                      ) : null}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 shrink-0 text-destructive hover:text-destructive"
                      onClick={() => removeNode(index)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* 订阅预览 */}
          {subs.length > 0 && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <Rss className="h-4 w-4" />
                  {t('localImport.subsTitle', 'Subscriptions to import')}
                  <Badge variant="secondary" className="ms-1">
                    {subs.length}
                  </Badge>
                </CardTitle>
                <CardDescription>
                  {t('localImport.subDefaultNote', 'No auto-update, direct connection by default')}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {subs.map((sub, index) => (
                  <div
                    key={`${sub.name}-${index}`}
                    className="flex items-center gap-2 p-2 rounded-md border bg-muted/30"
                  >
                    <div className="flex-1 min-w-0">
                      <span className="text-sm font-medium truncate block">{sub.name}</span>
                      <span className="text-xs text-muted-foreground truncate block">
                        {sub.url}
                      </span>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 shrink-0 text-destructive hover:text-destructive"
                      onClick={() => removeSub(index)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          {/* 跳过统计 */}
          {parsed && dropped > 0 && (
            <p className="text-xs text-muted-foreground">
              {t('localImport.skippedTitle', {
                defaultValue: '{{count}} item(s) skipped (unsupported protocol or parse error)',
                count: dropped,
              })}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button onClick={handleImport} disabled={total === 0 || isImporting}>
            {isImporting ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin me-2" />
                {t('localImport.importing', 'Importing...')}
              </>
            ) : (
              t('localImport.submit', { defaultValue: 'Import {{count}} item(s)', count: total })
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
