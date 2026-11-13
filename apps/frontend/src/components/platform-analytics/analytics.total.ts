export interface AnalyticsTotalItem {
  data: Array<{ total: number | string; date: string }>;
  average?: boolean;
  format?: 'percent' | 'duration';
}

// Seconds as m:ss, or h:mm:ss from an hour up.
export const formatDuration = (seconds: number) => {
  const whole = Math.max(0, Math.round(seconds));
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
};

// The number on an analytics card: the sum of the daily values, or their mean
// for an average series. An average without a format is a percentage, which
// is what every average series was before 'duration' existed (YouTube's
// Average View Duration is in seconds and used to read '29.40%').
export const formatAnalyticsTotal = (item: AnalyticsTotalItem) => {
  const sum =
    item?.data?.reduce((acc, curr) => acc + (Number(curr.total) || 0), 0) || 0;
  const value = item.average && item.data.length ? sum / item.data.length : sum;
  if (item.average && item.format === 'duration') {
    return formatDuration(value);
  }
  if (item.average) {
    return value.toFixed(2) + '%';
  }
  return new Intl.NumberFormat().format(Math.round(value));
};
