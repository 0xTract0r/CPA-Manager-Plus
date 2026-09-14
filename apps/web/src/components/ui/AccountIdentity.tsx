import { useCallback, useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { readEmailLike, type AccountIdentityView } from '@/utils/accountIdentity';
import styles from './AccountIdentity.module.scss';

type TooltipPlacement = 'above' | 'below';

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
  testId,
}: {
  email: string;
  masked: string;
  className?: string;
  focusable?: boolean;
  testId?: string;
}) {
  const tooltipId = useId();
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<ReturnType<typeof resolveTooltipPosition> | null>(null);
  const isBrowser = typeof document !== 'undefined';

  const updatePosition = useCallback(() => {
    if (!triggerRef.current || typeof window === 'undefined') return;
    setPosition(resolveTooltipPosition(triggerRef.current));
  }, []);
  const show = useCallback(() => {
    updatePosition();
    setOpen(true);
  }, [updatePosition]);
  const hide = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition]);

  if (!email || !masked) return null;

  const tooltip = (
    <span
      id={tooltipId}
      role="tooltip"
      className={styles.tooltip}
      data-placement={position?.placement ?? 'below'}
      style={isBrowser ? position?.style : undefined}
      data-testid={testId ? `${testId}-tooltip` : undefined}
    >
      {email}
    </span>
  );

  return (
    <>
      <span
        ref={triggerRef}
        className={[styles.email, className].filter(Boolean).join(' ')}
        tabIndex={focusable ? 0 : undefined}
        aria-label={email}
        aria-describedby={open ? tooltipId : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={focusable ? show : undefined}
        onBlur={focusable ? hide : undefined}
        data-testid={testId}
      >
        {masked}
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
  emailFocusable = true,
  testId,
}: {
  identity: AccountIdentityView;
  className?: string;
  compact?: boolean;
  showFallback?: boolean;
  emailFocusable?: boolean;
  testId?: string;
}) {
  const fallbackVisible =
    showFallback &&
    identity.fallback &&
    identity.fallback !== identity.primary &&
    identity.fallback !== identity.email;
  const fallbackEmail = readEmailLike(identity.fallback);

  return (
    <span
      className={[styles.identity, compact ? styles.compact : '', className]
        .filter(Boolean)
        .join(' ')}
      data-has-note={identity.hasNote ? 'true' : 'false'}
      data-testid={testId}
    >
      {identity.primaryIsEmail ? (
        <AccountEmailReveal
          email={identity.email}
          masked={identity.primary}
          className={styles.primary}
          focusable={emailFocusable}
          testId={testId ? `${testId}-email` : undefined}
        />
      ) : (
        <span className={styles.primary} title={identity.note || identity.fallback || undefined}>
          {identity.primary}
        </span>
      )}
      {!identity.primaryIsEmail && identity.email ? (
        <AccountEmailReveal
          email={identity.email}
          masked={identity.maskedEmail}
          className={styles.secondary}
          focusable={emailFocusable}
          testId={testId ? `${testId}-email` : undefined}
        />
      ) : identity.secondary ? (
        <span className={styles.secondary} title={identity.fallback || undefined}>
          {identity.secondary}
        </span>
      ) : null}
      {fallbackVisible && fallbackEmail ? (
        <AccountEmailReveal
          email={fallbackEmail}
          masked={identity.maskedFallback}
          className={styles.fallback}
          focusable={emailFocusable}
          testId={testId ? `${testId}-fallback-email` : undefined}
        />
      ) : fallbackVisible ? (
        <span className={styles.fallback} title={identity.fallback}>
          {identity.maskedFallback}
        </span>
      ) : null}
    </span>
  );
}
