import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { IconCheck, IconCopy } from '@/components/ui/icons';
import { useAccountPrivacyStore } from '@/stores/useAccountPrivacyStore';
import { copyToClipboard } from '@/utils/clipboard';
import { CONTENT_REVEAL_OPEN_EVENT } from '@/utils/contentReveal';
import { maskAccountEmail, readEmailLike, type AccountIdentityView } from '@/utils/accountIdentity';
import styles from './AccountIdentity.module.scss';

type TooltipPlacement = 'above' | 'below';
const REVEAL_OPEN_DELAY_MS = 500;
const REVEAL_CLOSE_DELAY_MS = 180;

const resolveTooltipPosition = (trigger: HTMLElement) => {
  const rect = trigger.getBoundingClientRect();
  const margin = 12;
  const gap = 8;
  const estimatedWidth = Math.min(360, Math.max(180, window.innerWidth - margin * 2));
  const left = Math.min(
    Math.max(rect.left + rect.width / 2 - estimatedWidth / 2, margin),
    Math.max(margin, window.innerWidth - estimatedWidth - margin)
  );
  const placement: TooltipPlacement = window.innerHeight - rect.bottom >= 72 ? 'below' : 'above';
  const style: CSSProperties = {
    left,
    top: placement === 'below' ? rect.bottom + gap : rect.top - gap,
    maxWidth: estimatedWidth,
    transform: placement === 'above' ? 'translateY(-100%)' : undefined,
  };
  return { placement, style };
};

export function AccountEmailReveal({
  email,
  masked,
  className,
  focusable = true,
  displayMode = 'global',
  displayValue,
  testId,
}: {
  email: string;
  masked: string;
  className?: string;
  focusable?: boolean;
  displayMode?: 'global' | 'full' | 'masked';
  displayValue?: string;
  testId?: string;
}) {
  const { t } = useTranslation();
  const globalMaskEmails = useAccountPrivacyStore((state) => state.maskEmails);
  const tooltipId = useId();
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLSpanElement | null>(null);
  const openTimerRef = useRef<number | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [copied, setCopied] = useState(false);
  const [position, setPosition] = useState<ReturnType<typeof resolveTooltipPosition> | null>(null);
  const isBrowser = typeof document !== 'undefined';
  const shouldMask = displayMode === 'masked' || (displayMode === 'global' && globalMaskEmails);
  const maskedValue = masked && masked !== email ? masked : maskAccountEmail(email);
  const visibleValue = displayValue || (shouldMask ? maskedValue : email);
  const [revealedContent, setRevealedContent] = useState({ email, visibleValue });
  if (revealedContent.email !== email || revealedContent.visibleValue !== visibleValue) {
    setRevealedContent({ email, visibleValue });
    setOpen(false);
    setPinned(false);
    setCopied(false);
  }
  const canAutomaticallyReveal = useCallback(() => {
    if (visibleValue !== email) return true;
    const trigger = triggerRef.current;
    return Boolean(
      trigger &&
      (trigger.scrollWidth > trigger.clientWidth + 1 ||
        trigger.scrollHeight > trigger.clientHeight + 1)
    );
  }, [email, visibleValue]);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current === null || typeof window === 'undefined') return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current === null || typeof window === 'undefined') return;
    window.clearTimeout(openTimerRef.current);
    openTimerRef.current = null;
  }, []);

  const updatePosition = useCallback(() => {
    if (!triggerRef.current || typeof window === 'undefined') return;
    setPosition(resolveTooltipPosition(triggerRef.current));
  }, []);
  const showImmediately = useCallback(() => {
    clearCloseTimer();
    clearOpenTimer();
    updatePosition();
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent<string>(CONTENT_REVEAL_OPEN_EVENT, { detail: tooltipId })
      );
    }
    setOpen(true);
  }, [clearCloseTimer, clearOpenTimer, tooltipId, updatePosition]);
  const show = useCallback(() => {
    clearCloseTimer();
    clearOpenTimer();
    if (!canAutomaticallyReveal()) return;
    if (typeof window === 'undefined') {
      showImmediately();
      return;
    }
    openTimerRef.current = window.setTimeout(() => {
      openTimerRef.current = null;
      // 等待期间可能切换宽度；完整可见的内容不再自动展开。
      if (canAutomaticallyReveal()) showImmediately();
    }, REVEAL_OPEN_DELAY_MS);
  }, [canAutomaticallyReveal, clearCloseTimer, clearOpenTimer, showImmediately]);
  const hide = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    setPinned(false);
    setOpen(false);
  }, [clearCloseTimer, clearOpenTimer]);
  const requestHide = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    if (pinned) return;
    if (typeof window === 'undefined') {
      setOpen(false);
      return;
    }
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setOpen(false);
    }, REVEAL_CLOSE_DELAY_MS);
  }, [clearCloseTimer, clearOpenTimer, pinned]);

  const keepOpen = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
  }, [clearCloseTimer, clearOpenTimer]);

  const togglePinned = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    if (pinned) {
      hide();
      return;
    }
    showImmediately();
    setPinned(true);
  }, [clearCloseTimer, clearOpenTimer, hide, pinned, showImmediately]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLSpanElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        hide();
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        togglePinned();
      }
    },
    [hide, togglePinned]
  );

  const handleBlur = useCallback(
    (event: FocusEvent<HTMLSpanElement>) => {
      const nextTarget = event.relatedTarget;
      if (
        nextTarget instanceof Node &&
        (triggerRef.current?.contains(nextTarget) || tooltipRef.current?.contains(nextTarget))
      ) {
        return;
      }
      requestHide();
    },
    [requestHide]
  );

  const handleCopy = useCallback(
    async (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();
      if (await copyToClipboard(email)) setCopied(true);
    },
    [email]
  );

  useEffect(() => {
    clearOpenTimer();
    clearCloseTimer();
  }, [email, visibleValue, clearOpenTimer, clearCloseTimer]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleOtherRevealOpen = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== tooltipId) hide();
    };
    window.addEventListener(CONTENT_REVEAL_OPEN_EVENT, handleOtherRevealOpen);
    return () => window.removeEventListener(CONTENT_REVEAL_OPEN_EVENT, handleOtherRevealOpen);
  }, [hide, tooltipId]);

  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    const handleResize = () => {
      const hasFocus =
        typeof document !== 'undefined' &&
        (triggerRef.current?.contains(document.activeElement) ||
          tooltipRef.current?.contains(document.activeElement));
      if (!pinned && !hasFocus && !canAutomaticallyReveal()) hide();
      else updatePosition();
    };
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', handleResize);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [canAutomaticallyReveal, hide, open, pinned, updatePosition]);

  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const handlePointerDown = (event: globalThis.MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || tooltipRef.current?.contains(target)) return;
      hide();
    };
    const handleDocumentKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') hide();
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleDocumentKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleDocumentKeyDown);
    };
  }, [hide, open]);

  useEffect(
    () => () => {
      clearOpenTimer();
      clearCloseTimer();
    },
    [clearCloseTimer, clearOpenTimer]
  );

  if (!email || !maskedValue) return null;

  const tooltip = (
    <span
      ref={tooltipRef}
      id={tooltipId}
      role="dialog"
      aria-label={email}
      className={styles.tooltip}
      data-placement={position?.placement ?? 'below'}
      style={isBrowser ? position?.style : undefined}
      data-testid={testId ? `${testId}-tooltip` : undefined}
      onMouseEnter={keepOpen}
      onMouseLeave={requestHide}
      onMouseDown={keepOpen}
    >
      <code className={styles.tooltipText} tabIndex={0}>
        {email}
      </code>
      <button
        type="button"
        className={styles.copyButton}
        onClick={handleCopy}
        title={t('common.copy')}
        aria-label={t('common.copy')}
        data-testid={testId ? `${testId}-copy` : undefined}
      >
        {copied ? <IconCheck size={14} /> : <IconCopy size={14} />}
      </button>
    </span>
  );

  if (!shouldMask) {
    return (
      <>
        <span
          ref={triggerRef}
          className={[styles.fullEmail, className].filter(Boolean).join(' ')}
          tabIndex={focusable ? 0 : undefined}
          aria-label={email}
          aria-describedby={open ? tooltipId : undefined}
          aria-expanded={open}
          aria-haspopup="dialog"
          onMouseEnter={show}
          onMouseLeave={requestHide}
          onFocus={focusable ? showImmediately : undefined}
          onBlur={focusable ? handleBlur : undefined}
          onClick={togglePinned}
          onKeyDown={focusable ? handleKeyDown : undefined}
          data-email-visibility="full"
          data-testid={testId}
        >
          {displayValue || email}
        </span>
        {open && (isBrowser ? createPortal(tooltip, document.body) : tooltip)}
      </>
    );
  }

  return (
    <>
      <span
        ref={triggerRef}
        className={[styles.email, className].filter(Boolean).join(' ')}
        tabIndex={focusable ? 0 : undefined}
        aria-label={email}
        aria-describedby={open ? tooltipId : undefined}
        aria-expanded={open}
        aria-haspopup="dialog"
        onMouseEnter={show}
        onMouseLeave={requestHide}
        onFocus={focusable ? showImmediately : undefined}
        onBlur={focusable ? handleBlur : undefined}
        onClick={togglePinned}
        onKeyDown={focusable ? handleKeyDown : undefined}
        data-email-visibility="masked"
        data-testid={testId}
      >
        {displayValue || maskedValue}
      </span>
      {open && (isBrowser ? createPortal(tooltip, document.body) : tooltip)}
    </>
  );
}

export function AccountIdentity({
  identity,
  className,
  compact = false,
  showFallback = false,
  showSecondaryEmail = true,
  noteLabel,
  primaryEmailLabel,
  secondaryEmailLabel,
  emailFocusable = true,
  testId,
}: {
  identity: AccountIdentityView;
  className?: string;
  compact?: boolean;
  showFallback?: boolean;
  showSecondaryEmail?: boolean;
  noteLabel?: ReactNode;
  primaryEmailLabel?: ReactNode;
  secondaryEmailLabel?: ReactNode;
  emailFocusable?: boolean;
  testId?: string;
}) {
  const maskEmails = useAccountPrivacyStore((state) => state.maskEmails);
  const fallbackVisible =
    showFallback &&
    identity.fallback &&
    identity.fallback !== identity.primary &&
    identity.fallback !== identity.email &&
    !readEmailLike(identity.fallback);
  const fallbackText = maskEmails ? identity.maskedFallback : identity.fallback;
  const primaryLabel = identity.primaryIsEmail
    ? primaryEmailLabel
    : identity.hasNote
      ? noteLabel
      : undefined;
  const hasPrimaryLabel = Boolean(primaryLabel);

  return (
    <span
      className={[
        styles.identity,
        hasPrimaryLabel ? styles.labeled : '',
        compact ? styles.compact : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      data-has-note={identity.hasNote ? 'true' : 'false'}
      data-testid={testId}
    >
      {identity.primaryIsEmail ? (
        <span className={styles.primaryRow}>
          {primaryLabel ? <span className={styles.identityLabel}>{primaryLabel}</span> : null}
          <AccountEmailReveal
            email={identity.email}
            masked={identity.primary}
            className={styles.primary}
            focusable={emailFocusable}
            testId={testId ? `${testId}-email` : undefined}
          />
        </span>
      ) : (
        <span className={styles.primaryRow}>
          {primaryLabel ? <span className={styles.identityLabel}>{primaryLabel}</span> : null}
          <span className={styles.primary} title={identity.note || identity.fallback || undefined}>
            {identity.hasNote ? identity.note : fallbackText || '-'}
          </span>
        </span>
      )}
      {!identity.primaryIsEmail && identity.email && showSecondaryEmail ? (
        <>
          {secondaryEmailLabel ? (
            <span className={`${styles.identityLabel} ${styles.secondaryIdentityLabel}`}>
              {secondaryEmailLabel}
            </span>
          ) : null}
          <AccountEmailReveal
            email={identity.email}
            masked={identity.maskedEmail}
            className={styles.secondary}
            focusable={emailFocusable}
            testId={testId ? `${testId}-email` : undefined}
          />
        </>
      ) : null}
      {fallbackVisible ? (
        <span className={styles.fallback} title={identity.fallback}>
          {fallbackText}
        </span>
      ) : null}
    </span>
  );
}
