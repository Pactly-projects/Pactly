/**
 * Issue #52: Tests for weekly availability range overlap validation.
 */
import "./testConfigEnv.js";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  validateWeeklyRanges,
  formatOverlapErrors,
  WeeklyRangeOverlapError,
  type WeeklyTimeRange,
  type OverlapError,
} from "../src/services/availability.js";

test("validateWeeklyRanges rejects overlapping ranges on the same weekday", () => {
  const ranges: WeeklyTimeRange[] = [
    { weekday: 1, startMinutes: 540, endMinutes: 720 }, // Monday 09:00-12:00
    { weekday: 1, startMinutes: 660, endMinutes: 780 }, // Monday 11:00-13:00
  ];
  
  const errors = validateWeeklyRanges(ranges);
  
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.weekday, 1);
  assert.equal(errors[0]!.range1.start, "09:00");
  assert.equal(errors[0]!.range1.end, "12:00");
  assert.equal(errors[0]!.range2.start, "11:00");
  assert.equal(errors[0]!.range2.end, "13:00");
});

test("validateWeeklyRanges accepts non-overlapping ranges on the same weekday", () => {
  const ranges: WeeklyTimeRange[] = [
    { weekday: 1, startMinutes: 540, endMinutes: 720 }, // Monday 09:00-12:00
    { weekday: 1, startMinutes: 780, endMinutes: 1020 }, // Monday 13:00-17:00
  ];
  
  const errors = validateWeeklyRanges(ranges);
  
  assert.equal(errors.length, 0);
});

test("validateWeeklyRanges treats touching ranges as overlaps", () => {
  const ranges: WeeklyTimeRange[] = [
    { weekday: 1, startMinutes: 540, endMinutes: 720 }, // Monday 09:00-12:00
    { weekday: 1, startMinutes: 720, endMinutes: 780 }, // Monday 12:00-13:00 (starts exactly when first ends)
  ];
  
  const errors = validateWeeklyRanges(ranges);
  
  assert.equal(errors.length, 1);
  assert.equal(errors[0]!.weekday, 1);
});

test("validateWeeklyRanges allows same clock times on different weekdays", () => {
  const ranges: WeeklyTimeRange[] = [
    { weekday: 1, startMinutes: 540, endMinutes: 720 }, // Monday 09:00-12:00
    { weekday: 2, startMinutes: 540, endMinutes: 720 }, // Tuesday 09:00-12:00
  ];
  
  const errors = validateWeeklyRanges(ranges);
  
  assert.equal(errors.length, 0);
});

test("validateWeeklyRanges detects multiple overlaps", () => {
  const ranges: WeeklyTimeRange[] = [
    { weekday: 1, startMinutes: 540, endMinutes: 720 }, // Monday 09:00-12:00
    { weekday: 1, startMinutes: 660, endMinutes: 780 }, // Monday 11:00-13:00
    { weekday: 1, startMinutes: 700, endMinutes: 800 }, // Monday 11:40-13:20
  ];
  
  const errors = validateWeeklyRanges(ranges);
  
  // Should find 3 overlaps: (1,2), (1,3), (2,3)
  assert.equal(errors.length, 3);
});

test("validateWeeklyRanges handles ranges that fully contain another", () => {
  const ranges: WeeklyTimeRange[] = [
    { weekday: 1, startMinutes: 540, endMinutes: 780 }, // Monday 09:00-13:00
    { weekday: 1, startMinutes: 600, endMinutes: 720 }, // Monday 10:00-12:00 (fully inside first)
  ];
  
  const errors = validateWeeklyRanges(ranges);
  
  assert.equal(errors.length, 1);
});

test("validateWeeklyRanges returns empty array for valid ranges", () => {
  const ranges: WeeklyTimeRange[] = [
    { weekday: 0, startMinutes: 480, endMinutes: 600 }, // Sunday 08:00-10:00
    { weekday: 1, startMinutes: 540, endMinutes: 720 }, // Monday 09:00-12:00
    { weekday: 1, startMinutes: 780, endMinutes: 900 }, // Monday 13:00-15:00
    { weekday: 2, startMinutes: 600, endMinutes: 720 }, // Tuesday 10:00-12:00
  ];
  
  const errors = validateWeeklyRanges(ranges);
  
  assert.equal(errors.length, 0);
});

test("validateWeeklyRanges returns empty array for empty input", () => {
  const errors = validateWeeklyRanges([]);
  assert.equal(errors.length, 0);
});

test("validateWeeklyRanges returns empty array for single range", () => {
  const ranges: WeeklyTimeRange[] = [
    { weekday: 1, startMinutes: 540, endMinutes: 720 },
  ];
  
  const errors = validateWeeklyRanges(ranges);
  assert.equal(errors.length, 0);
});

test("formatOverlapErrors creates readable error message", () => {
  const errors: OverlapError[] = [
    {
      weekday: 1,
      range1: { start: "09:00", end: "12:00" },
      range2: { start: "11:00", end: "13:00" },
    },
  ];
  
  const message = formatOverlapErrors(errors);
  
  assert.ok(message.includes("Monday"));
  assert.ok(message.includes("09:00–12:00"));
  assert.ok(message.includes("11:00–13:00"));
  assert.ok(message.includes("overlaps"));
});

test("formatOverlapErrors handles multiple errors", () => {
  const errors: OverlapError[] = [
    {
      weekday: 1,
      range1: { start: "09:00", end: "12:00" },
      range2: { start: "11:00", end: "13:00" },
    },
    {
      weekday: 3,
      range1: { start: "14:00", end: "16:00" },
      range2: { start: "15:00", end: "17:00" },
    },
  ];
  
  const message = formatOverlapErrors(errors);
  
  assert.ok(message.includes("Monday"));
  assert.ok(message.includes("Wednesday"));
  assert.ok(message.includes(";"));
});

test("formatOverlapErrors returns empty string for no errors", () => {
  const message = formatOverlapErrors([]);
  assert.equal(message, "");
});

test("WeeklyRangeOverlapError carries overlap details", () => {
  const overlaps: OverlapError[] = [
    {
      weekday: 1,
      range1: { start: "09:00", end: "12:00" },
      range2: { start: "11:00", end: "13:00" },
    },
  ];
  
  const error = new WeeklyRangeOverlapError(overlaps);
  
  assert.equal(error.overlaps.length, 1);
  assert.ok(error.message.includes("Monday"));
  assert.equal(error.name, "WeeklyRangeOverlapError");
});
