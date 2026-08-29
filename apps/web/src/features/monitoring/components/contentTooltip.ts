const CONTENT_TOOLTIP_OVERFLOW_EPSILON_PX = 1;

export const hasOverflowingContent = (trigger: HTMLElement) => {
  const markedTargets = Array.from(
    trigger.querySelectorAll<HTMLElement>('[data-overflow-content="true"]')
  );
  const targets = markedTargets.length > 0 ? markedTargets : [trigger];
  return targets.some(
    (target) =>
      target.scrollWidth > target.clientWidth + CONTENT_TOOLTIP_OVERFLOW_EPSILON_PX ||
      target.scrollHeight > target.clientHeight + CONTENT_TOOLTIP_OVERFLOW_EPSILON_PX
  );
};
