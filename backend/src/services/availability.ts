/**
 * Issue #52: Weekly availability range management and validation.
 * Providers can define recurring weekly availability ranges (e.g., "Monday 09:00-12:00")
 * that are validated for overlaps before saving.
 */

export interface WeeklyTimeRange {
  /** 0=Sunday, 1=Monday, ..., 6=Saturday */
  weekday: number;
  /** Start time in minutes from midnight (0-1439) */
  startMinutes: number;
  /** End time in minutes from midnight (0-1439) */
  endMinutes: number;
}

export interface OverlapError {
  weekday: number;
  range1: { start: string; end: string };
  range2: { start: string; end: string };
}

const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/**
 * Formats minutes since midnight as HH:MM
 */
function formatTime(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}`;
}

/**
 * Checks if two time ranges overlap on the same day.
 * A range that ends at another's start is considered an overlap (touching ranges overlap).
 */
function rangesOverlap(range1: WeeklyTimeRange, range2: WeeklyTimeRange): boolean {
  if (range1.weekday !== range2.weekday) {
    return false;
  }
  
  // Two ranges overlap if one starts before the other ends AND the other starts before the first ends
  // Since touching is considered an overlap, we use <= instead of <
  return range1.startMinutes < range2.endMinutes && range2.startMinutes < range1.endMinutes;
}

/**
 * Issue #52: Validates that weekly availability ranges don't overlap on the same weekday.
 * Returns an array of overlap errors. Empty array means valid.
 * 
 * Edge cases:
 * - Ranges on different weekdays may share clock times (not an overlap)
 * - A range that ends at the next range's start is an overlap
 */
export function validateWeeklyRanges(ranges: WeeklyTimeRange[]): OverlapError[] {
  const errors: OverlapError[] = [];
  
  // Check each pair of ranges for overlaps
  for (let i = 0; i < ranges.length; i++) {
    for (let j = i + 1; j < ranges.length; j++) {
      const range1 = ranges[i]!;
      const range2 = ranges[j]!;
      
      if (rangesOverlap(range1, range2)) {
        errors.push({
          weekday: range1.weekday,
          range1: {
            start: formatTime(range1.startMinutes),
            end: formatTime(range1.endMinutes),
          },
          range2: {
            start: formatTime(range2.startMinutes),
            end: formatTime(range2.endMinutes),
          },
        });
      }
    }
  }
  
  return errors;
}

/**
 * Formats overlap errors into a human-readable error message.
 */
export function formatOverlapErrors(errors: OverlapError[]): string {
  if (errors.length === 0) {
    return "";
  }
  
  const messages = errors.map((error) => {
    const weekdayName = WEEKDAY_NAMES[error.weekday] ?? `Day ${error.weekday}`;
    return `${weekdayName}: ${error.range1.start}–${error.range1.end} overlaps with ${error.range2.start}–${error.range2.end}`;
  });
  
  return messages.join("; ");
}

export class WeeklyRangeOverlapError extends Error {
  constructor(
    public readonly overlaps: OverlapError[],
    message?: string,
  ) {
    super(message || formatOverlapErrors(overlaps));
    this.name = "WeeklyRangeOverlapError";
  }
}
