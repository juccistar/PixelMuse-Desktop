import { App, Button, Image, Popconfirm } from "antd";
import { Info, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Asset, ProjectDetail, UserAssetKind } from "../../api/adapters/projectDetail";
import { useDeleteAsset, useUploadAsset } from "../../api/hooks/useAssets";
import { errorText } from "../../lib/errorText";
import { useBusinessActive } from '../../components/businessActivity';
import { useFileDropTarget } from "../../lib/fileDrop";
import { kindForRole, USER_ASSET_KIND_META, USER_ASSET_KIND_ORDER } from "../../lib/roles";
import { LibraryPickerDialog } from "../library/LibraryPickerDialog";
import { CollectionDialog, CollectionSources } from '../collection/CollectionDialog';
import styles from "./workbench.module.css";
export function AssetsStage({ detail, compact = false }: { detail: ProjectDetail; compact?: boolean }) {
    const { notification } = App.useApp();
    const businessActive = useBusinessActive();
    const [kind, setKind] = useState<UserAssetKind>("PRODUCT");
    const [libraryOpen, setLibraryOpen] = useState(false);
    const [collectionOpen, setCollectionOpen] = useState(false);
    const upload = useUploadAsset();
    const removeAsset = useDeleteAsset();
    const existingHashes = useMemo(() => new Set(detail.assets.map(asset => asset.hash).filter((hash): hash is string => Boolean(hash))), [detail.assets]);
    const uploadFiles = async (files: File[] | FileList, targetKind: UserAssetKind) => {
        const queue = Array.from(files).filter(file => file.type.startsWith('image/') || file.type === '');
        if (!queue.length) { notification.error({ title: '只支持图片文件' }); return; }
        const worker = async () => {
            while (queue.length) {
                const file = queue.shift();
                if (!file) return;
                try { await upload.mutateAsync({ projectId: detail.id, file, kind: targetKind }); }
                catch (error) { notification.error({ title: '上传失败', description: errorText(error) }); }
            }
        };
        await Promise.all([worker(), worker()]);
    };
    useEffect(() => {
        if (!businessActive) return;
        const onPaste = (event: ClipboardEvent) => {
            const images = Array.from(event.clipboardData?.files ?? []).filter(file => file.type.startsWith('image/') || file.type === '');
            if (!images.length) return;
            event.preventDefault();
            void uploadFiles(images, kind);
        };
        document.addEventListener('paste', onPaste);
        return () => document.removeEventListener('paste', onPaste);
    }, [businessActive, detail.id, kind]);
    const onDelete = (asset: Asset) => {
        void removeAsset.mutateAsync({ assetId: asset.id, projectId: detail.id }).catch(error => notification.error({ title: '删除失败', description: errorText(error) }));
    };
    return <div className={styles.preparationAssets} data-compact={compact}>
      {USER_ASSET_KIND_ORDER.map(item => <AssetSection key={item} kind={item} assets={detail.assets.filter(asset => kindForRole(asset.role) === item)} protectedMode={detail.defaultMode === 'PIXEL_PROTECTED'} onDelete={onDelete} onActivate={() => setKind(item)} onUpload={files => { setKind(item); void uploadFiles(files, item); }} onLibrary={() => { setKind(item); setLibraryOpen(true); }} onCollect={() => setCollectionOpen(true)}/>)}
      <LibraryPickerDialog open={libraryOpen} projectId={detail.id} kind={kind} excludeHashes={existingHashes} onClose={() => setLibraryOpen(false)}/>
      {collectionOpen ? <CollectionDialog projectId={detail.id} onClose={() => setCollectionOpen(false)}/> : null}
      <CollectionSources projectId={detail.id}/>
    </div>;
}
function AssetSection({ kind, assets, protectedMode, onDelete, onActivate, onUpload, onLibrary, onCollect }: {
    kind: UserAssetKind; assets: Asset[]; protectedMode: boolean; onDelete: (asset: Asset) => void;
    onActivate: () => void; onUpload: (files: FileList | File[]) => void; onLibrary: () => void; onCollect: () => void;
}) {
    const { dragging, dropProps } = useFileDropTarget(onUpload);
    const product = kind === 'PRODUCT';
    const label = product ? '商品图' : '参考图';
    return <section className={styles.preparationAssetSection} data-kind={kind} data-over={dragging} onFocusCapture={onActivate} onPointerDown={onActivate} {...dropProps}>
      <header className={styles.preparationAssetHeader}>
        <h2>{label}</h2><span>{assets.length} 张 · {product ? '商品外观依据' : '仅参考风格与构图'}</span>
        <Button type="text" size="small" onClick={product ? onLibrary : onCollect}>{product ? '从资产库添加' : '采集参考图'} ›</Button>
      </header>
      <div className={styles.preparationAssetGrid} data-kind={kind} data-empty={!assets.length}>
        <Image.PreviewGroup>
          {assets.map(asset => <AssetCard key={asset.id} asset={asset} showShield={protectedMode && product} onDelete={() => onDelete(asset)}/>)}
        </Image.PreviewGroup>
        <label className={styles.preparationUpload}>
          <input type="file" accept="image/*" multiple className={styles.fileInput} aria-label={`上传${label}`} onChange={event => { if (event.target.files) onUpload(event.target.files); event.target.value = ''; }}/>
          <Plus size={28} strokeWidth={1.5} aria-hidden/><span>上传{label}</span>{!assets.length ? <small>拖入图片，或点击选择 · 支持粘贴</small> : null}
        </label>
      </div>
      {!product ? <div className={styles.preparationReferenceNote}><Info size={14} aria-hidden/><span>参考图不会成为商品参数或已核验卖点</span><button type="button" onClick={onLibrary}>从资产库添加</button></div> : null}
    </section>;
}
function AssetCard({ asset, showShield, onDelete }: { asset: Asset; showShield: boolean; onDelete: () => void }) {
    const kind = kindForRole(asset.role);
    return <article className={styles.preparationAssetCard}>
      <Image src={asset.url} alt={USER_ASSET_KIND_META[kind].label} loading="lazy"/>
      {showShield ? <ShieldCheck className={styles.shield} size={16} aria-label="像素保护素材"/> : null}
      <Popconfirm title="删除这张素材？" okText="删除" cancelText="取消" onConfirm={onDelete}>
        <button type="button" className={styles.assetDelete} aria-label={`删除素材 ${USER_ASSET_KIND_META[kind].label}`}><Trash2 size={14} aria-hidden/></button>
      </Popconfirm>
    </article>;
}
