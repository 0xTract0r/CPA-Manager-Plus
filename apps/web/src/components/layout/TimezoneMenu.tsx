import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { useTimezone } from '@/hooks/useTimezone';
import { DEFAULT_TIME_ZONE, getTimeZoneOffsetLabel } from '@/utils/timezone';

/**
 * 全局「显示时区」开关（TZ2 / #49）。
 *
 * 时区是**全局**展示偏好（不是 per-account 设置），因此挂在应用顶栏偏好区，与语言 /
 * 主题 / 视觉效果开关并列，而不是塞进渲染明文 token 的 per-account 账号设置弹框。
 * 选择后写入全局时区 store（localStorage 持久化，见 utils/timezone），并通过
 * useTimezone() 的 useSyncExternalStore 通知所有订阅组件重渲染，让全站走
 * formatInTimezone/formatDateTimeUtc8 的时间展示同步切换。
 */

const clockIcon = (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);

interface ZoneOption {
  /** 特殊值 `local`：点击时解析成浏览器所在时区；其余为 IANA 时区名。 */
  value: string;
  labelKey: string;
}

/**
 * 精选时区列表：至少含默认 UTC+8（上海）、UTC+0、浏览器本地；其余为常见时区。
 * 每项右侧的 UTC 偏移标注在渲染期动态计算（DST 感知），不硬编码，避免夏令时漂移。
 */
const ZONE_OPTIONS: ZoneOption[] = [
  { value: 'local', labelKey: 'timezone.zones.local' },
  { value: 'Asia/Shanghai', labelKey: 'timezone.zones.shanghai' },
  { value: 'UTC', labelKey: 'timezone.zones.utc' },
  { value: 'Asia/Tokyo', labelKey: 'timezone.zones.tokyo' },
  { value: 'Asia/Kolkata', labelKey: 'timezone.zones.kolkata' },
  { value: 'Europe/Moscow', labelKey: 'timezone.zones.moscow' },
  { value: 'Europe/London', labelKey: 'timezone.zones.london' },
  { value: 'America/New_York', labelKey: 'timezone.zones.newYork' },
  { value: 'America/Los_Angeles', labelKey: 'timezone.zones.losAngeles' },
];

function resolveBrowserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || DEFAULT_TIME_ZONE;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

export function TimezoneMenu() {
  const { t } = useTranslation();
  // 订阅全局时区：切换后本菜单重渲染以更新「当前项」高亮；同时全站订阅组件一起重渲染。
  const { timeZone, setTimeZone } = useTimezone();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  const handleSelect = useCallback(
    (value: string) => {
      setTimeZone(value === 'local' ? resolveBrowserTimeZone() : value);
      setOpen(false);
    },
    [setTimeZone]
  );

  const switchLabel = t('timezone.switch', { defaultValue: 'Display timezone' });

  return (
    <div className={`timezone-menu ${open ? 'open' : ''}`} ref={menuRef}>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen((prev) => !prev)}
        title={switchLabel}
        aria-label={switchLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="timezone-menu-toggle"
      >
        {clockIcon}
      </Button>
      {open && (
        <div
          className="notification entering timezone-menu-popover"
          role="menu"
          aria-label={switchLabel}
        >
          {ZONE_OPTIONS.map((option) => {
            const resolved = option.value === 'local' ? resolveBrowserTimeZone() : option.value;
            const active = resolved === timeZone;
            const offset = getTimeZoneOffsetLabel(resolved);
            return (
              <button
                key={option.value}
                type="button"
                className={`timezone-menu-option ${active ? 'active' : ''}`}
                onClick={() => handleSelect(option.value)}
                role="menuitemradio"
                aria-checked={active}
                data-testid={`timezone-option-${option.value}`}
              >
                <span>
                  {t(option.labelKey)} · {offset}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
