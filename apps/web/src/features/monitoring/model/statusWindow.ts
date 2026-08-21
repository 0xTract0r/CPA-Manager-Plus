import { formatDayAxisUtc8, formatInUtc8 } from '@/utils/datetime';

export const formatStatusWindowLabel = (
  startTime: number,
  endTime: number,
  locale: string
) => {
  const dateOptions: Intl.DateTimeFormatOptions = { month: 'numeric', day: 'numeric' };
  const timeOptions: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
  // 展示与同日判定都走全局时区，避免跟随浏览器本地时区导致标注/换行不一致。
  const sameDay = formatDayAxisUtc8(startTime) === formatDayAxisUtc8(endTime);
  const startDateLabel = formatInUtc8(startTime, dateOptions, locale);
  const endDateLabel = formatInUtc8(endTime, dateOptions, locale);
  const startTimeLabel = formatInUtc8(startTime, timeOptions, locale);
  const endTimeLabel = formatInUtc8(endTime, timeOptions, locale);

  return sameDay
    ? `${startDateLabel} ${startTimeLabel} - ${endTimeLabel}`
    : `${startDateLabel} ${startTimeLabel} - ${endDateLabel} ${endTimeLabel}`;
};
