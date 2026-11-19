import { Button, Result, Skeleton } from "antd";
import { ArrowLeft } from "lucide-react";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Link, UNSAFE_DataRouterContext, useBlocker, useParams, useSearchParams } from "react-router";
import { useBeforeAppNavigate, type BeforeNavigate } from '../../components/navigationGuard';
import { BusinessActivityContext, useBusinessActive, useBusinessNavigate } from '../../components/businessActivity';
import { useProjectEvents } from "../../api/hooks/useProjectEvents";
import { useProject } from "../../api/hooks/useProjects";
import { AppTopbar } from "../../components/AppTopbar";
import { StageBar } from "../../components/StageBar";
import { completedViews, deriveView, parseView, type WorkbenchView } from "../../lib/stages";
import { errorText } from "../../lib/errorText";
import { ResultsWorkspace } from "./ResultsWorkspace";
import { AssetsStage } from "./AssetsStage";
import { SetupPanel, type SetupPanelHandle } from "./SetupPanel";
import { StoryboardStage } from "./StoryboardStage";
import styles from "./workbench.module.css";
export function WorkbenchPage() {
    const { projectId } = useParams();
    const [searchParams] = useSearchParams();
    const navigate = useBusinessNavigate();
    const active = useBusinessActive();
    const dataRouter = useContext(UNSAFE_DataRouterContext);
    const navigationGuard = useRef<BeforeNavigate | null>(null);
    const setup = useRef<SetupPanelHandle>(null);
    const [footerContainer, setFooterContainer] = useState<HTMLDivElement | null>(null);
    const registerNavigationGuard = useCallback((guard: BeforeNavigate | null) => { navigationGuard.current = guard; }, []);
    const beforeNavigate = useCallback(async () => {
        if (setup.current && !await setup.current.flush()) return false;
        return navigationGuard.current?.() ?? true;
    }, []);
    const routeGuard = useRef<BeforeNavigate | null>(beforeNavigate);
    useBeforeAppNavigate(beforeNavigate);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const project = useProject(projectId);
    useProjectEvents(projectId);
    const derived = project.data ? deriveView(project.data) : "setup";
    const view = parseView(searchParams.get("view") ?? searchParams.get("stage"), derived);
    const done = useMemo(() => (project.data ? completedViews(project.data) : new Set<WorkbenchView>()), [project.data]);
    const setView = (next: WorkbenchView) => {
        if (!projectId || next === view) return;
        const nextParams = new URLSearchParams(searchParams);
        nextParams.set("view", next);
        nextParams.delete("stage");
        nextParams.delete("item");
        void beforeNavigate().then(allowed => { if (allowed) void navigate(`/projects/${projectId}?${nextParams.toString()}`, { replace: true }); });
    };
    if (project.isPending) return <div className={styles.page}><div className={styles.missing}><Skeleton active paragraph={{ rows: 6 }}/></div></div>;
    if (project.isError || !project.data) return <Result status="error" title="项目加载失败" subTitle={errorText(project.error)} extra={<Link to="/"><Button>返回项目画廊</Button></Link>}/>;
    const detail = project.data;
    return (<div className={styles.page}>
      {dataRouter ? <WorkbenchRouteGuard guard={routeGuard}/> : null}
      <AppTopbar current="workbench" brand={<Link to="/" className={styles.brandLink} onClick={event => { event.preventDefault(); void beforeNavigate().then(allowed => { if (allowed) void navigate('/'); }); }}>
        <ArrowLeft size={19} strokeWidth={1.5} aria-hidden/><span className={styles.projectName}>{detail.name}</span>
      </Link>} center={<StageBar current={view} completed={done} onChange={setView}/>} settingsOpen={settingsOpen} onSettingsOpenChange={setSettingsOpen}/>
      {view === 'setup' ? <div className={styles.preparationWorkspace}>
        <div className={styles.preparationColumns}>
          <main className={styles.preparationMedia}>
            <header className={styles.preparationIntro}><h1>准备商品，开始创作</h1><p>上传商品图和参考图，配置一次，AI 规划整套画面</p></header>
            <AssetsStage detail={detail} compact={false}/>
          </main>
          <aside className={styles.preparationConfig} aria-label="制作配置">
            <BusinessActivityContext.Provider value={active}><SetupPanel ref={setup} detail={detail} footerContainer={footerContainer} onPlanned={() => setView('storyboard')}/></BusinessActivityContext.Provider>
          </aside>
        </div>
        <div className={styles.preparationFooterHost} ref={setFooterContainer}/>
      </div> : <div className={styles.shell} data-collapsed={false} data-view={view}>
        <main className={styles.preview}>
          {view === "storyboard" ? <StoryboardStage key={detail.id} detail={detail} onGenerated={() => setView("results")} registerNavigationGuard={registerNavigationGuard}/> : null}
          {view === "results" ? <ResultsWorkspace detail={detail}/> : null}
        </main>
      </div>}
    </div>);
}

/** 路由后退、项目切换也等待准备草稿保存及规划修改确认。 */
function WorkbenchRouteGuard({ guard }: { guard: { current: BeforeNavigate | null } }) {
    const blocker = useBlocker(() => guard.current !== null);
    const deciding = useRef(false);
    useEffect(() => {
        if (blocker.state !== 'blocked' || deciding.current) return;
        deciding.current = true;
        void Promise.resolve(guard.current?.() ?? true).then(allowed => {
            if (allowed) blocker.proceed(); else blocker.reset();
        }).finally(() => { deciding.current = false; });
    }, [blocker, guard]);
    return null;
}
