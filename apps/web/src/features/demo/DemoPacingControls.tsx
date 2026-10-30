import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { getPacingStoryState, controlPacingStory } from '@/features/demo/demoFixtures';

const phases: Record<string, string> = {
  waiting_new: '新会话等待余额达到4',
  reserved: '已预约1次，尚未发送',
  sending: '正在执行模拟请求',
  tool: '工具续轮准备中',
  waiting_continuation: '续轮等待余额达到1（CPA最多等30秒）',
  retry_later: '已本地拒绝：恢复超过30秒，等待客户端稍后重试',
  refilling: '本轮已完成，空闲自然补额',
  reauth: '模拟账号需要重新授权，停止准入',
};
export function DemoPacingControls({
  onRefresh,
  active = true,
  accountFileName,
}: {
  onRefresh: () => unknown;
  active?: boolean;
  accountFileName?: string;
}) {
  const refreshRef = useRef(onRefresh);
  useLayoutEffect(() => {
    refreshRef.current = onRefresh;
  }, [onRefresh]);
  const [state, setState] = useState(getPacingStoryState);
  useEffect(() => {
    const initial = getPacingStoryState();
    if (!active || !initial || (accountFileName && initial.account_file_name !== accountFileName))
      return;
    const tick = window.setInterval(() => {
      if (!document.hidden) setState(getPacingStoryState());
    }, 1000);
    const refresh = window.setInterval(() => {
      if (!document.hidden) void refreshRef.current();
    }, 5000);
    return () => {
      clearInterval(tick);
      clearInterval(refresh);
    };
  }, [active, accountFileName]);
  if (!state || (accountFileName && state.account_file_name !== accountFileName)) return null;
  const action = (command: 'pause' | 'resume' | 'replay' | 'advance') => {
    controlPacingStory(command);
    setState(getPacingStoryState());
    void refreshRef.current();
  };
  return (
    <div
      data-testid="demo-pacing-controls"
      style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginTop: 8 }}
    >
      <span data-testid="demo-pacing-story-state">
        纯本地业务演示 · {state.paused ? '已暂停' : '正常时间 1×'} · 模拟{' '}
        {Math.floor(state.elapsed_seconds / 60)}分{state.elapsed_seconds % 60}秒 ·{' '}
        {phases[state.phase]} · 完成 {state.completed}/{state.total}
        {state.fast_forwarded_seconds > 0
          ? ` · 已演示快进${state.fast_forwarded_seconds / 60}分钟（补额速率未变）`
          : ''}
      </span>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => action(state.paused ? 'resume' : 'pause')}
      >
        {state.paused ? '继续演示' : '暂停演示'}
      </Button>
      <Button size="sm" variant="secondary" onClick={() => action('replay')}>
        重播（重置模拟账号）
      </Button>
      <Button size="sm" variant="secondary" onClick={() => action('advance')}>
        演示快进1分钟
      </Button>
    </div>
  );
}
