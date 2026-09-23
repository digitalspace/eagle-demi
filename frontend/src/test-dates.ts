/**
 * A fixture instant built from LOCAL wall-clock parts, so a test asserting a rendered date reads
 * the same in BC as it does on a UTC box. `2014-10-14T00:00:00Z` is the 13th in Vancouver; local
 * noon is the 14th everywhere. Default to noon for the fixtures that only assert a day.
 */
export const localIso = (year: number, month: number, day: number, hour = 12, minute = 0) =>
  new Date(year, month, day, hour, minute).toISOString();
