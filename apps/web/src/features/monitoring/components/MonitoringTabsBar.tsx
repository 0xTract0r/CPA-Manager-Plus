import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ComponentType,
  type KeyboardEvent,
} from 'react';
import {
  IconKey,
  IconSidebarMonitor,
  IconSidebarProviders,
  type IconProps,
} from '@/components/ui/icons';
import styles from '../MonitoringCenterPage.module.scss';

export type MonitoringTabBadgeTone = 'default' | 'failure';

export type MonitoringTabsVariant = 'standalone' | 'cards';

export type MonitoringTabIcon = 'accounts' | 'apiKeys' | 'realtime';

export type MonitoringTab<Id extends string = string> = {
  id: Id;
  label: string;
  fullLabel?: string;
  icon?: MonitoringTabIcon;
  badge?: string | number | null;
  badgeTitle?: string;
  badgeTone?: MonitoringTabBadgeTone;
};

type MonitoringTabsBarProps<Id extends string> = {
  tabs: ReadonlyArray<MonitoringTab<Id>>;
  activeTab: Id;
  onChange: (tab: Id) => void;
  ariaLabel: string;
  idBase?: string;
  variant?: MonitoringTabsVariant;
};

const tabIconMap: Record<MonitoringTabIcon, ComponentType<IconProps>> = {
  accounts: IconSidebarProviders,
  apiKeys: IconKey,
  realtime: IconSidebarMonitor,
};

export function MonitoringTabsBar<Id extends string>({
  tabs,
  activeTab,
  onChange,
  ariaLabel,
  idBase = 'monitoring-data-tabs',
  variant = 'standalone',
}: MonitoringTabsBarProps<Id>) {
  const buttonRefs = useRef<Map<Id, HTMLButtonElement | null>>(new Map());

  const focusableTabs = useMemo(() => tabs.map((tab) => tab.id), [tabs]);

  const focusTab = useCallback((tabId: Id) => {
    const node = buttonRefs.current.get(tabId);
    node?.focus();
  }, []);

  // 走查修复：`variant="cards"` 的胶囊标签组窄容器下退化为横向滚动（见 .tabsBarCards
  // 的 overflow-x:auto），单靠滚动条本身不保证用户能看到当前激活的标签（如"实时"）。
  // 挂载/切换时把激活按钮滚入可视区（inline:'nearest' 只在真正超出视口时才滚动，
  // 不会在已可见时产生多余跳动）。react-test-renderer 的宿主 ref 默认是 null、
  // jsdom 部分环境也可能不实现 scrollIntoView，因此做双重防御性判空。
  useEffect(() => {
    const node = buttonRefs.current.get(activeTab);
    if (node && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
  }, [activeTab]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, currentId: Id) => {
      if (focusableTabs.length === 0) return;
      const currentIndex = focusableTabs.indexOf(currentId);
      if (currentIndex === -1) return;

      let nextIndex = currentIndex;
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          nextIndex = (currentIndex + 1) % focusableTabs.length;
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          nextIndex = (currentIndex - 1 + focusableTabs.length) % focusableTabs.length;
          break;
        case 'Home':
          nextIndex = 0;
          break;
        case 'End':
          nextIndex = focusableTabs.length - 1;
          break;
        default:
          return;
      }

      event.preventDefault();
      const nextId = focusableTabs[nextIndex];
      onChange(nextId);
      focusTab(nextId);
    },
    [focusTab, focusableTabs, onChange]
  );

  const isCards = variant === 'cards';
  const barClass = [styles.tabsBar, isCards ? styles.tabsBarCards : '']
    .filter(Boolean)
    .join(' ');

  return (
    <div className={barClass} role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        const badgeClass = [
          styles.tabBadge,
          tab.badgeTone === 'failure' ? styles.tabBadgeFailure : '',
        ]
          .filter(Boolean)
          .join(' ');
        const buttonClass = [
          styles.tabButton,
          isCards ? styles.tabButtonCard : '',
          isActive ? styles.tabButtonActive : '',
          isActive && isCards ? styles.tabButtonActiveCard : '',
        ]
          .filter(Boolean)
          .join(' ');
        const Icon = tab.icon ? tabIconMap[tab.icon] : null;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              buttonRefs.current.set(tab.id, node);
            }}
            type="button"
            role="tab"
            id={`${idBase}-${tab.id}`}
            aria-selected={isActive}
            aria-controls={`${idBase}-${tab.id}-panel`}
            tabIndex={isActive ? 0 : -1}
            className={buttonClass}
            title={tab.fullLabel ?? tab.label}
            onClick={() => {
              if (!isActive) onChange(tab.id);
            }}
            onKeyDown={(event) => handleKeyDown(event, tab.id)}
          >
            {Icon ? (
              <span className={styles.tabIcon} aria-hidden="true">
                <Icon size={18} />
              </span>
            ) : null}
            <span className={styles.tabLabel}>{tab.label}</span>
            {tab.badge !== undefined && tab.badge !== null && tab.badge !== '' ? (
              <span className={badgeClass} title={tab.badgeTitle}>
                {tab.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
