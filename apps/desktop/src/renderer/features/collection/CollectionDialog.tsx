import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Checkbox, Drawer, Image, Input, Space, Spin, Tag } from 'antd';
import { ExternalLink, ImagePlus, Link2, RefreshCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { CollectionInput, CollectionOutput, CollectionSnapshot } from '@ecomgen/contracts';
import { collection } from '../../api/nativeClient';
import { qk } from '../../api/queryKeys';
import { errorText } from '../../lib/errorText';
import styles from './CollectionDialog.module.css';
export const collectionSourcesKey = (projectId: string) => ['collection-sources', projectId] as const;
export function validCollectionUrl(value: string): boolean {
    try { const url = new URL(value.trim()); return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password; }
    catch { return false; }
}
// 浏览器候选有数量上限；预览在本地顺序解码，避免同屏卡片同时占用下载通道。
let previewQueue: Promise<unknown> = Promise.resolve();
function queuedPreview(input: CollectionInput<'preview'>, signal: AbortSignal): Promise<CollectionOutput<'preview'>> {
    const result = previewQueue.then(() => {
        if (signal.aborted) throw new DOMException('预览已取消', 'AbortError');
        return collection('preview', input);
    });
    previewQueue = result.catch(() => undefined);
    return result;
}
type ImportResult = { candidateId: string; label: string; status: 'IMPORTED' | 'ALREADY_PRESENT' | 'FAILED'; error?: string };
/** 独立原生窗口正常浏览，工作台只展示本地预览与服务端确认的导入结果。 */
export function CollectionDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
    const queryClient = useQueryClient();
    const [url, setUrl] = useState('');
    const [imageUrl, setImageUrl] = useState('');
    const [snapshot, setSnapshot] = useState<CollectionSnapshot | null>(null);
    const snapshotRef = useRef<CollectionSnapshot | null>(null);
    const mounted = useRef(true);
    const stopImport = useRef(false);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [pending, setPending] = useState<string | null>(null);
    const [importing, setImporting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [results, setResults] = useState<ImportResult[]>([]);
    const [page, setPage] = useState(0);
    const apply = (next: CollectionSnapshot) => {
        if (!mounted.current) return;
        const previous = snapshotRef.current;
        if (previous?.collectionId === next.collectionId && previous.revision > next.revision) return;
        if (!previous || previous.collectionId !== next.collectionId || previous.revision !== next.revision || next.state === 'CLOSED') {
            setSelected(new Set()); setPage(0);
        }
        snapshotRef.current = next; setSnapshot(next);
    };
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false; stopImport.current = true;
            const current = snapshotRef.current;
            if (current) void collection('close', { collectionId: current.collectionId }).catch(() => undefined);
        };
    }, []);
    const session = useQuery({ queryKey: ['collection-session', snapshot?.collectionId], queryFn: () => collection('status', { collectionId: snapshot!.collectionId }), enabled: snapshot?.state === 'OPEN', staleTime: 0, retry: false, refetchInterval: 1200 });
    useEffect(() => { if (session.data && session.data.collectionId === snapshotRef.current?.collectionId) apply(session.data); }, [session.data]);
    const refreshSources = () => {
        void queryClient.invalidateQueries({ queryKey: qk.project(projectId) });
        void queryClient.invalidateQueries({ queryKey: ['library-assets'] });
        void queryClient.invalidateQueries({ queryKey: collectionSourcesKey(projectId) });
    };
    const openPage = async () => {
        if (!validCollectionUrl(url)) { setError('请输入完整的 HTTP 或 HTTPS 商品链接，链接中不能包含账号或密码。'); return; }
        setPending('open'); setError(null); setResults([]);
        try {
            if (snapshotRef.current) await collection('close', { collectionId: snapshotRef.current.collectionId });
            const next = await collection('open', { projectId, url: url.trim() });
            if (!mounted.current) { await collection('close', { collectionId: next.collectionId }); return; }
            apply(next);
        } catch (cause) { if (mounted.current) setError(errorText(cause)); }
        finally { if (mounted.current) setPending(null); }
    };
    const action = async (operation: 'refresh' | 'addImage' | 'clearSession') => {
        const current = snapshotRef.current;
        if (!current) return;
        if (operation === 'addImage' && !validCollectionUrl(imageUrl)) { setError('请输入完整的 HTTP 或 HTTPS 图片链接。'); return; }
        setPending(operation); setError(null);
        try {
            if (operation === 'clearSession') {
                await collection('clearSession', { collectionId: current.collectionId });
                apply(await collection('status', { collectionId: current.collectionId }));
            } else if (operation === 'addImage') {
                apply(await collection('addImage', { collectionId: current.collectionId, url: imageUrl.trim() })); setImageUrl('');
            } else apply(await collection('refresh', { collectionId: current.collectionId }));
        } catch (cause) { if (mounted.current) setError(errorText(cause)); }
        finally { if (mounted.current) setPending(null); }
    };
    const close = async () => {
        stopImport.current = true; setPending('close'); setError(null);
        try {
            if (snapshotRef.current) await collection('close', { collectionId: snapshotRef.current.collectionId });
            refreshSources(); onClose();
        } catch (cause) { setError(errorText(cause)); }
        finally { if (mounted.current) setPending(null); }
    };
    const cancelImport = async () => {
        stopImport.current = true; setPending('cancel');
        try {
            const current = snapshotRef.current;
            if (current) {
                await collection('close', { collectionId: current.collectionId });
                apply(await collection('status', { collectionId: current.collectionId }));
            }
        } catch (cause) { setError(errorText(cause)); }
        finally { refreshSources(); if (mounted.current) setPending(null); }
    };
    const importImages = async () => {
        const current = snapshotRef.current;
        if (!current || current.state !== 'OPEN' || !selected.size) return;
        const candidates = current.candidates.filter(item => selected.has(item.candidateId));
        setImporting(true); setError(null); setResults([]); stopImport.current = false;
        try {
            const fresh = await collection('status', { collectionId: current.collectionId });
            apply(fresh);
            if (fresh.revision !== current.revision || fresh.state !== 'OPEN') { setError('页面已变化，请重新读取图片后选择。'); return; }
            for (const item of candidates) {
                if (stopImport.current || !mounted.current) break;
                try {
                    const result = await collection('import', { collectionId: current.collectionId, revision: current.revision, candidateId: item.candidateId });
                    if (mounted.current) {
                        setResults(previous => [...previous, { candidateId: item.candidateId, label: item.label, status: result.status }]);
                        setSelected(previous => { const next = new Set(previous); next.delete(item.candidateId); return next; });
                    }
                } catch (cause) {
                    if (mounted.current) setResults(previous => [...previous, { candidateId: item.candidateId, label: item.label, status: 'FAILED', error: errorText(cause) }]);
                }
                refreshSources();
            }
        } catch (cause) { if (mounted.current) setError(errorText(cause)); }
        finally { if (mounted.current) setImporting(false); refreshSources(); }
    };
    const currentOpen = snapshot?.state === 'OPEN';
    const busy = Boolean(pending) || importing;
    const candidates = snapshot?.candidates ?? [];
    const pageItems = candidates.slice(page * 8, page * 8 + 8);
    return <Drawer open title="电商灵感采集" size={640} onClose={() => void close()} maskClosable={!importing} keyboard={!importing} extra={snapshot ? <Tag>{currentOpen ? '浏览窗口已打开' : '浏览窗口已关闭'}</Tag> : null} footer={<div className={styles.footer}><span>已选择 {selected.size} 张 · 导入为参考图</span><Space>{importing ? <Button danger loading={pending === 'cancel'} disabled={Boolean(pending)} onClick={() => void cancelImport()}>取消导入</Button> : null}<Button type="primary" disabled={!currentOpen || !selected.size || busy} loading={importing} onClick={() => void importImages()}>导入当前项目</Button></Space></div>}>
      <p className={styles.intro}>打开商品链接，在独立窗口正常浏览或登录。滚动加载图片后，回到这里读取并选择参考图。</p>
      <label className={styles.label} htmlFor="collection-page-url">商品链接</label>
      <div className={styles.inputRow}><Input id="collection-page-url" aria-label="商品链接" placeholder="https://…" value={url} disabled={busy} onChange={event => setUrl(event.target.value)} onPressEnter={() => { if (!busy) void openPage(); }}/><Button icon={<ExternalLink size={15}/>} disabled={!url.trim() || busy} loading={pending === 'open'} onClick={() => void openPage()}>打开浏览窗口</Button></div>
      {error ? <Alert type="error" showIcon title="采集操作未完成" description={error} closable onClose={() => setError(null)}/> : null}
      {session.isError ? <Alert type="error" showIcon title="无法读取浏览窗口状态" description={errorText(session.error)} action={<Button size="small" onClick={() => void session.refetch()}>重试</Button>}/> : null}
      {snapshot ? <section className={styles.session} aria-label="采集候选">
        <div className={styles.pageInfo}><Link2 size={17} aria-hidden/><div><strong>{snapshot.page?.title || '当前浏览页面'}</strong><small>{snapshot.page?.platform || '网页'}{snapshot.page?.url ? ` · ${snapshot.page.url}` : ''}</small></div></div>
        {snapshot.error ? <Alert type="warning" title="当前页面提示" description={snapshot.error} showIcon/> : null}
        {!currentOpen ? <Alert type="info" showIcon title="浏览窗口已关闭" description="可以重新打开商品链接继续采集；已经导入的参考图保留在项目中。"/> : null}
        <div className={styles.toolbar}><span>{candidates.length} 张候选图片</span><Space><Button size="small" icon={<RefreshCw size={13}/>} disabled={!currentOpen || busy} loading={pending === 'refresh'} onClick={() => void action('refresh')}>读取当前页图片</Button><Button size="small" disabled={!currentOpen || busy} loading={pending === 'clearSession'} onClick={() => void action('clearSession')}>清除本次登录</Button></Space></div>
        {candidates.length === 0 ? <div className={styles.empty}><ImagePlus size={28}/><strong>还没有读取到图片</strong><p>在浏览窗口滚动到商品图片，等待加载后点击“读取当前页图片”。也可以使用下方的图片链接或上传本地图片。</p></div> : <>
          <div className={styles.grid}>{pageItems.map((candidate, index) => <Candidate key={`${snapshot.collectionId}:${snapshot.revision}:${candidate.candidateId}`} candidate={candidate} selection={{ collectionId: snapshot.collectionId, revision: snapshot.revision, candidateId: candidate.candidateId }} index={page * 8 + index + 1} selected={selected.has(candidate.candidateId)} disabled={!currentOpen || busy} onSelect={checked => setSelected(previous => { const next = new Set(previous); if (checked) next.add(candidate.candidateId); else next.delete(candidate.candidateId); return next; })}/>)}</div>
          {candidates.length > 8 ? <div className={styles.pagination}><Button size="small" disabled={page === 0} onClick={() => setPage(value => value - 1)}>上一页</Button><span>{page + 1} / {Math.ceil(candidates.length / 8)}</span><Button size="small" disabled={(page + 1) * 8 >= candidates.length} onClick={() => setPage(value => value + 1)}>下一页</Button></div> : null}
        </>}
        <div className={styles.manual}><label className={styles.label} htmlFor="collection-image-url">手动添加图片链接</label><div className={styles.inputRow}><Input id="collection-image-url" aria-label="图片链接" placeholder="https://…/image.jpg" value={imageUrl} disabled={!currentOpen || busy} onChange={event => setImageUrl(event.target.value)} onPressEnter={() => { if (currentOpen && !busy) void action('addImage'); }}/><Button disabled={!currentOpen || !imageUrl.trim() || busy} loading={pending === 'addImage'} onClick={() => void action('addImage')}>添加候选</Button></div></div>
      </section> : <div className={styles.empty}><Link2 size={28}/><strong>把灵感带进项目</strong><p>采集当前页面可访问的图片。图片只作为参考，不会更改商品事实或素材的既有角色。</p></div>}
      {results.length > 0 ? <section className={styles.results} aria-label="采集导入结果" aria-live="polite"><h3>导入结果</h3>{results.map(item => <div key={item.candidateId}><Tag color={item.status === 'FAILED' ? 'error' : item.status === 'IMPORTED' ? 'success' : 'default'}>{item.status === 'FAILED' ? '未导入' : item.status === 'IMPORTED' ? '已导入' : '项目中已存在'}</Tag><span>{item.label || '参考图片'}{item.error ? ` · ${item.error}` : ''}</span></div>)}</section> : null}
      <p className={styles.fallback}>页面需要验证或图片无法访问时，请在网站正常完成验证，或将图片保存到本地后使用工作台“上传素材”。关闭采集会结束本次浏览会话。</p>
    </Drawer>;
}
function Candidate({ candidate, selection, index, selected, disabled, onSelect }: { candidate: CollectionSnapshot['candidates'][number]; selection: CollectionInput<'preview'>; index: number; selected: boolean; disabled: boolean; onSelect: (checked: boolean) => void }) {
    const preview = useQuery({ queryKey: ['collection-preview', selection], queryFn: ({ signal }) => queuedPreview(selection, signal), staleTime: Infinity, gcTime: 0, retry: false });
    return <article className={styles.candidate} data-selected={selected}>
      <div className={styles.preview}>{preview.data ? <Image src={preview.data.dataUrl} alt={`采集图片 ${index}`} width="100%"/> : preview.isPending ? <Spin size="small"/> : <Button size="small" onClick={() => void preview.refetch()}>重试预览</Button>}</div>
      <Checkbox checked={selected} disabled={disabled} aria-label={`选择图片 ${index}`} onChange={event => onSelect(event.target.checked)}><span className={styles.candidateLabel}>{candidate.label || `图片 ${index}`}</span></Checkbox>
      <small>{candidate.width} × {candidate.height}{preview.isError ? ' · 预览失败，可重试' : ''}</small>
    </article>;
}
/** 来源来自持久化查询；重新启动仍能追溯已采集的参考图。 */
export function CollectionSources({ projectId }: { projectId: string }) {
    const sources = useQuery({ queryKey: collectionSourcesKey(projectId), queryFn: () => collection('sources', { projectId }), retry: false });
    if (sources.isError) return <Alert type="warning" showIcon title="采集来源读取失败" description={errorText(sources.error)} action={<Button size="small" onClick={() => void sources.refetch()}>重试</Button>}/>;
    if (!sources.data?.items.length) return null;
    return <section className={styles.sources} aria-label="采集来源"><h3>参考图来源</h3>{sources.data.items.map(source => <div key={source.assetId}><span><strong>{source.title || '商品参考图'}</strong><Tag>{source.platform}</Tag></span><code>{source.pageUrl}</code><time dateTime={source.collectedAt}>{new Date(source.collectedAt).toLocaleString('zh-CN')}</time></div>)}</section>;
}
