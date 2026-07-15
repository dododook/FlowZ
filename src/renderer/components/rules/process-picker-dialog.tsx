import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loader2, RotateCw, Search } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/ipc/api-client';
import type { SystemProcessInfo } from '@/bridge/types';
import { useTranslation } from 'react-i18next';

interface ProcessPickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 'name' → 取进程名；'path' → 取进程完整路径（无路径项禁选） */
  mode: 'name' | 'path';
  onAdd: (values: string[]) => void;
}

// 系统进程路径启发式（隐藏系统进程开关用）
const SYSTEM_PATH_RE = /^(\/usr\/|\/System\/|\/sbin\/|\/bin\/|[A-Za-z]:\\Windows\\)/i;

export function ProcessPickerDialog({ open, onOpenChange, mode, onAdd }: ProcessPickerDialogProps) {
  const { t } = useTranslation();
  const [processes, setProcesses] = useState<SystemProcessInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [hideSystem, setHideSystem] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = async () => {
    setLoading(true);
    try {
      const list = await api.system.listProcesses();
      setProcesses(list);
    } catch (e) {
      toast.error(t('rules.processPicker.loadFailed', '获取进程列表失败'), {
        description: e instanceof Error ? e.message : undefined,
      });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) {
      setSelected(new Set());
      setSearch('');
      void load();
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return processes.filter((p) => {
      if (hideSystem && p.path && SYSTEM_PATH_RE.test(p.path)) return false;
      if (!q) return true;
      return p.name.toLowerCase().includes(q) || (p.path?.toLowerCase().includes(q) ?? false);
    });
  }, [processes, search, hideSystem, mode]);

  const keyOf = (p: SystemProcessInfo) => (mode === 'path' ? p.path || '' : p.name);

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleAdd = () => {
    onAdd(Array.from(selected));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('rules.processPicker.title', '选择进程')}</DialogTitle>
          <DialogDescription>
            {t('rules.processPicker.desc', '从运行中的进程选择，快速加入进程规则')}
          </DialogDescription>
        </DialogHeader>

        <div className="min-w-0 space-y-3">
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              <Search className="absolute start-2 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('rules.processPicker.search', '搜索进程名 / 路径')}
                className="ps-8"
              />
            </div>
            <Button variant="outline" size="icon" onClick={() => void load()} disabled={loading}>
              <RotateCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </Button>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">
              {t('rules.processPicker.hideSystem', '隐藏系统进程')}
            </span>
            <Switch checked={hideSystem} onCheckedChange={setHideSystem} />
          </div>

          <ScrollArea className="h-72 rounded-md border">
            {loading ? (
              <div className="flex h-72 items-center justify-center text-muted-foreground">
                <Loader2 className="me-2 h-4 w-4 animate-spin" />
                {t('common.loading', '加载中...')}
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex h-72 items-center justify-center text-sm text-muted-foreground">
                {t('rules.processPicker.empty', '没有匹配的进程')}
              </div>
            ) : (
              <div className="divide-y divide-border/60">
                {filtered.map((p, i) => {
                  const key = keyOf(p);
                  const disabled = mode === 'path' && !p.path;
                  return (
                    <label
                      key={`${p.name}-${i}`}
                      className={`flex items-center gap-3 px-3 py-2 ${
                        disabled ? 'opacity-40' : 'cursor-pointer hover:bg-muted/50'
                      }`}
                    >
                      <Checkbox
                        checked={selected.has(key)}
                        disabled={disabled}
                        onCheckedChange={() => !disabled && toggle(key)}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{p.name}</div>
                        {p.path && (
                          <div
                            className="break-all line-clamp-2 text-xs text-muted-foreground"
                            title={p.path}
                          >
                            {p.path}
                          </div>
                        )}
                        {disabled && (
                          <div className="text-xs text-muted-foreground">
                            {t('rules.processPicker.noPathDisabled', '无法获取路径')}
                          </div>
                        )}
                      </div>
                      {p.count > 1 && (
                        <span className="shrink-0 text-xs text-muted-foreground">×{p.count}</span>
                      )}
                    </label>
                  );
                })}
              </div>
            )}
          </ScrollArea>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('servers.cancel', '取消')}
          </Button>
          <Button onClick={handleAdd} disabled={selected.size === 0}>
            {t('rules.processPicker.addSelected', '添加 {{count}} 项', { count: selected.size })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
