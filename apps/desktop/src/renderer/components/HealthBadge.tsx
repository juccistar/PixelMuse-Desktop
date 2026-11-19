import { Tooltip } from 'antd';
import { useHealth } from '../api/hooks/useHealth';
import styles from './HealthBadge.module.css';
type HealthState = 'up' | 'down' | 'connecting';
const STATE_TEXT: Record<HealthState, string> = { up: '本地后台已连接', down: '本地后台未连接', connecting: '连接中' };
export function HealthBadge() {
  const query = useHealth();
  const state: HealthState = query.isLoading ? 'connecting' : query.isError || query.data?.status !== 'ready' ? 'down' : 'up';
  return <Tooltip title={query.isError ? '后台暂不可用，请等待恢复后重新查询' : '本地任务与数据服务'}>
    <span className={`${styles.badge} ${styles[state]}`} data-testid="health-badge"><span className={styles.dot} aria-hidden />{STATE_TEXT[state]}</span>
  </Tooltip>;
}
