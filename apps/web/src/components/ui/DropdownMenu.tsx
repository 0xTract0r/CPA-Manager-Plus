import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import styles from './DropdownMenu.module.scss';

export interface DropdownMenuItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'default' | 'danger';
}

interface DropdownMenuProps {
  items: DropdownMenuItem[];
  ariaLabel: string;
  triggerLabel?: ReactNode;
  triggerIcon?: ReactNode;
  triggerClassName?: string;
  align?: 'start' | 'end';
  disabled?: boolean;
}

const MENU_OFFSET = 6;
const MIN_MENU_WIDTH = 168;
const VIEWPORT_PADDING = 8;

export function DropdownMenu({
  items,
  ariaLabel,
  triggerLabel,
  triggerIcon,
  triggerClassName,
  align = 'end',
  disabled = false,
}: DropdownMenuProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const menuId = useId();

  const enabledIndices = useMemo(
    () => items.map((item, index) => (item.disabled ? -1 : index)).filter((value) => value >= 0),
    [items]
  );

  const focusItem = useCallback((index: number) => {
    const node = itemRefs.current[index];
    if (node) {
      // preventScroll: 滚动 / resize 重定位会重跑聚焦效果，若默认 scrollIntoView
      // 会在用户滚动时把页面拽回，造成跳动；这里只移焦点、不滚动。
      node.focus({ preventScroll: true });
    }
  }, []);

  const close = useCallback(() => {
    setIsOpen(false);
    setActiveIndex(-1);
    setPosition(null);
  }, []);

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const menuWidth = menuRef.current?.offsetWidth ?? MIN_MENU_WIDTH;
    const menuHeight = menuRef.current?.offsetHeight ?? 0;
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let left = align === 'end' ? rect.right - menuWidth : rect.left;
    left = Math.max(VIEWPORT_PADDING, Math.min(left, viewportWidth - menuWidth - VIEWPORT_PADDING));

    let top = rect.bottom + MENU_OFFSET;
    if (top + menuHeight > viewportHeight - VIEWPORT_PADDING) {
      top = Math.max(VIEWPORT_PADDING, rect.top - menuHeight - MENU_OFFSET);
    }

    setPosition({ top, left });
  }, [align]);

  const open = useCallback(
    // preference 决定初始高亮/聚焦项：鼠标点击或 ArrowDown 打开落到第一项，
    // ArrowUp 打开落到最后一项（标准 ARIA menu 键盘模式）。
    (preference: 'first' | 'last' = 'first') => {
      if (disabled) return;
      setIsOpen(true);
      const target =
        preference === 'last'
          ? (enabledIndices[enabledIndices.length - 1] ?? -1)
          : (enabledIndices[0] ?? -1);
      setActiveIndex(target);
    },
    [disabled, enabledIndices]
  );

  useLayoutEffect(() => {
    if (!isOpen) return;
    // Measure trigger / menu DOM after open to position the portal-rendered menu.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    updatePosition();
  }, [isOpen, updatePosition]);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointer = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      close();
    };

    const handleScroll = () => updatePosition();
    const handleResize = () => updatePosition();

    document.addEventListener('mousedown', handlePointer);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleResize);

    return () => {
      document.removeEventListener('mousedown', handlePointer);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleResize);
    };
  }, [close, isOpen, updatePosition]);

  // 焦点移入菜单（本次修复的核心）。
  //
  // 菜单经 createPortal 挂到 document.body，是独立子树；触发按钮才是 Modal/Drawer
  // 的 DOM 后代。初次打开时菜单先以 visibility:hidden 渲染（position 尚为 null）等待
  // 测量定位，此阶段元素不可聚焦——旧实现在该阶段就调用 focus()，静默失败，键盘焦点
  // 一直停在触发按钮上；且因依赖里没有 position，菜单定位可见后不再重跑，焦点永远进
  // 不了菜单。结果按 Esc 时事件从触发按钮发出，绕过本菜单的 onKeyDown/stopPropagation，
  // 冒泡到 Modal 的 document 级 Esc 监听器，关掉整个抽屉（真机 Playwright 实测坐实）。
  //
  // 修复：把 position 纳入依赖并 gate，只有菜单真正定位可见后才聚焦；聚焦落到当前
  // active 项（无可用项时退回聚焦菜单容器，menuRef 有 tabIndex=-1 且挂了 onKeyDown，
  // 保证 Esc 仍被本菜单拦截、不外泄）。方向键改变 activeIndex 时同一效果负责把焦点
  // 移到新项。
  useEffect(() => {
    if (!isOpen || !position) return;
    if (activeIndex >= 0) {
      focusItem(activeIndex);
    } else {
      menuRef.current?.focus({ preventScroll: true });
    }
  }, [activeIndex, focusItem, isOpen, position]);

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      open('first');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      open('last');
    }
  };

  const moveActive = useCallback(
    (delta: 1 | -1) => {
      if (enabledIndices.length === 0) return;
      const currentPosition = enabledIndices.indexOf(activeIndex);
      const nextPosition =
        currentPosition === -1
          ? delta === 1
            ? 0
            : enabledIndices.length - 1
          : (currentPosition + delta + enabledIndices.length) % enabledIndices.length;
      setActiveIndex(enabledIndices[nextPosition]);
    },
    [activeIndex, enabledIndices]
  );

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case 'Escape':
        // 菜单以 createPortal 挂到 document.body，DOM 上不是父级 Modal/Drawer 的
        // 子孙；Modal/Drawer 的 Esc 关闭监听器挂在 document 上（原生 keydown，非
        // React 合成事件树）。若这里只 close() 不 stopPropagation()，原生事件会
        // 继续冒泡到 document，被外层 Modal/Drawer 一并关掉（真机走查实测坐实）。
        // stopPropagation() 会连带调用底层原生 event.stopPropagation()，阻断继续
        // 冒泡，让 Esc 只关本菜单，父级弹层不受影响。
        event.preventDefault();
        event.stopPropagation();
        close();
        triggerRef.current?.focus({ preventScroll: true });
        break;
      case 'ArrowDown':
        event.preventDefault();
        moveActive(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveActive(-1);
        break;
      case 'Home':
        event.preventDefault();
        if (enabledIndices.length > 0) setActiveIndex(enabledIndices[0]);
        break;
      case 'End':
        event.preventDefault();
        if (enabledIndices.length > 0) setActiveIndex(enabledIndices[enabledIndices.length - 1]);
        break;
      case 'Tab':
        close();
        break;
      default:
        break;
    }
  };

  const handleItemClick = (item: DropdownMenuItem) => {
    if (item.disabled) return;
    close();
    item.onClick();
  };

  const triggerClasses = [styles.trigger, isOpen ? styles.triggerOpen : '', triggerClassName]
    .filter(Boolean)
    .join(' ');

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClasses}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-controls={isOpen ? menuId : undefined}
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={() => (isOpen ? close() : open())}
        onKeyDown={handleTriggerKeyDown}
      >
        {triggerIcon}
        {triggerLabel}
      </button>
      {isOpen && typeof document !== 'undefined'
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-label={ariaLabel}
              tabIndex={-1}
              className={styles.menu}
              style={
                position
                  ? { top: position.top, left: position.left }
                  : { visibility: 'hidden', top: 0, left: 0 }
              }
              onKeyDown={handleMenuKeyDown}
            >
              {items.map((item, index) => {
                const itemClasses = [
                  styles.item,
                  item.tone === 'danger' ? styles.itemDanger : '',
                  index === activeIndex ? styles.itemActive : '',
                ]
                  .filter(Boolean)
                  .join(' ');
                return (
                  <button
                    key={item.key}
                    ref={(node) => {
                      itemRefs.current[index] = node;
                    }}
                    type="button"
                    role="menuitem"
                    tabIndex={index === activeIndex ? 0 : -1}
                    className={itemClasses}
                    disabled={item.disabled}
                    onMouseEnter={() => !item.disabled && setActiveIndex(index)}
                    onClick={() => handleItemClick(item)}
                  >
                    {item.icon ? <span className={styles.itemIcon}>{item.icon}</span> : null}
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>,
            document.body
          )
        : null}
    </>
  );
}
