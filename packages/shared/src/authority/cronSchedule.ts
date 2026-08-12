import { Cron } from "croner";

const NICKNAME = /^@(yearly|annually|monthly|weekly|daily|midnight|hourly)$/iu;
const VALIDATION_ORIGIN = Date.UTC(2024, 0, 1);

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;
const WEEKDAY_TOKENS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
const MONTH_TOKENS = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
] as const;

export type CronVisualSchedule =
  | { mode: "hourly"; minute: number }
  | { mode: "daily"; hour: number; minute: number }
  | { mode: "weekly"; hour: number; minute: number; weekdays: number[] }
  | { mode: "monthly"; hour: number; minute: number; day: number | "last" };

export function canonicalCronExpression(expression: string): string {
  const trimmed = expression.trim();
  const nickname = NICKNAME.test(trimmed);
  if (!nickname && trimmed.split(/\s+/u).length !== 5) {
    throw new Error("Use the five-field minute, hour, day of month, month, and weekday format");
  }
  const canonical = nickname
    ? trimmed.toLowerCase()
    : trimmed.split(/\s+/u).join(" ").toUpperCase();
  try {
    const next = new Cron(canonical, { timezone: "UTC", paused: true }).nextRun(
      new Date(VALIDATION_ORIGIN)
    );
    if (!next || !Number.isSafeInteger(next.getTime())) {
      throw new Error("the schedule has no future occurrence");
    }
  } catch (error) {
    throw new Error(
      `Invalid cron schedule: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return canonical;
}

export function canonicalCronTimeZone(timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: timezone.trim() }).resolvedOptions()
      .timeZone;
  } catch (error) {
    throw new Error(
      `Use an IANA timezone such as America/New_York: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export function cronNextOccurrence(expression: string, timezone: string, after: number): number {
  const canonicalExpression = canonicalCronExpression(expression);
  const canonicalTimezone = canonicalCronTimeZone(timezone);
  let next: Date | null;
  try {
    next = new Cron(canonicalExpression, {
      timezone: canonicalTimezone,
      paused: true,
    }).nextRun(new Date(after));
  } catch (error) {
    throw new Error(
      `Invalid cron schedule: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!next || !Number.isSafeInteger(next.getTime())) {
    throw new Error("Cron schedule has no future occurrence");
  }
  return next.getTime();
}

export function cronUpcomingOccurrences(
  expression: string,
  timezone: string,
  after: number,
  count = 5
): number[] {
  if (!Number.isSafeInteger(count) || count < 1 || count > 20) {
    throw new Error("Cron preview count must be between 1 and 20");
  }
  const canonicalExpression = canonicalCronExpression(expression);
  const canonicalTimezone = canonicalCronTimeZone(timezone);
  const cron = new Cron(canonicalExpression, { timezone: canonicalTimezone, paused: true });
  const result: number[] = [];
  let cursor = new Date(after);
  for (let index = 0; index < count; index += 1) {
    const next = cron.nextRun(cursor);
    if (!next || !Number.isSafeInteger(next.getTime())) {
      throw new Error("Cron schedule has no future occurrence");
    }
    result.push(next.getTime());
    cursor = next;
  }
  return result;
}

export function cronExpressionFromVisual(schedule: CronVisualSchedule): string {
  if (schedule.mode === "hourly") {
    return `${boundedInteger(schedule.minute, 0, 59, "minute")} * * * *`;
  }
  const hour = boundedInteger(schedule.hour, 0, 23, "hour");
  const minute = boundedInteger(schedule.minute, 0, 59, "minute");
  if (schedule.mode === "daily") return `${minute} ${hour} * * *`;
  if (schedule.mode === "monthly") {
    const day = schedule.day === "last" ? "L" : boundedInteger(schedule.day, 1, 31, "day of month");
    return `${minute} ${hour} ${day} * *`;
  }
  const weekdays = [...new Set(schedule.weekdays)].sort(weekdayOrder);
  if (
    weekdays.length === 0 ||
    weekdays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)
  ) {
    throw new Error("Choose at least one weekday");
  }
  return `${minute} ${hour} * * ${weekdays.map((day) => WEEKDAY_TOKENS[day]).join(",")}`;
}

export function cronVisualSchedule(expression: string): CronVisualSchedule | null {
  const canonical = canonicalCronExpression(expression);
  if (canonical.startsWith("@")) return null;
  const [minuteField, hourField, dayField, monthField, weekdayField] = canonical.split(" ") as [
    string,
    string,
    string,
    string,
    string,
  ];
  const minute = exactInteger(minuteField, 0, 59);
  if (minute === null || monthField !== "*") return null;
  if (hourField === "*" && dayField === "*" && weekdayField === "*") {
    return { mode: "hourly", minute };
  }
  const hour = exactInteger(hourField, 0, 23);
  if (hour === null) return null;
  if (dayField === "*" && weekdayField === "*") return { mode: "daily", hour, minute };
  if (weekdayField === "*") {
    const day = dayField === "L" ? "last" : exactInteger(dayField, 1, 31);
    return day === null ? null : { mode: "monthly", hour, minute, day };
  }
  if (dayField !== "*") return null;
  const weekdays = parseWeekdayList(weekdayField);
  return weekdays ? { mode: "weekly", hour, minute, weekdays } : null;
}

export function describeCronExpression(expression: string, locale?: string): string {
  const canonical = canonicalCronExpression(expression);
  const nickname = describeNickname(canonical);
  if (nickname) return nickname;
  const [minute, hour, day, month, weekday] = canonical.split(" ") as [
    string,
    string,
    string,
    string,
    string,
  ];
  if (canonical === "* * * * *") return "Every minute";
  const minuteStep = /^\*\/(\d+)$/u.exec(minute);
  if (minuteStep && hour === "*" && day === "*" && month === "*" && weekday === "*") {
    return `Every ${minuteStep[1]} minutes`;
  }
  const exactMinute = exactInteger(minute, 0, 59);
  const exactHour = exactInteger(hour, 0, 23);
  if (
    exactMinute !== null &&
    exactHour === null &&
    hour === "*" &&
    day === "*" &&
    month === "*" &&
    weekday === "*"
  ) {
    return exactMinute === 0
      ? "At the start of every hour"
      : `Every hour at ${String(exactMinute).padStart(2, "0")} minutes past`;
  }
  if (exactMinute !== null && exactHour !== null) {
    const time = formatClockTime(exactHour, exactMinute, locale);
    const monthPhrase = describeMonth(month);
    const dayPhrase = describeDayOfMonth(day);
    const weekdayPhrase = describeDayOfWeek(weekday);
    const inMonths = monthPhrase ? ` in ${monthPhrase}` : "";
    if (!dayPhrase && !weekdayPhrase) return `Every day${inMonths} at ${time}`;
    if (!dayPhrase && weekdayPhrase) {
      return weekdayPhrase.periodic
        ? `${capitalize(weekdayPhrase.text)}${inMonths} at ${time}`
        : `Every ${weekdayPhrase.text}${inMonths} at ${time}`;
    }
    if (dayPhrase && !weekdayPhrase) return `${capitalize(dayPhrase)}${inMonths} at ${time}`;
    const andWeekday = weekday.startsWith("+");
    return andWeekday
      ? `${capitalize(dayPhrase!)}${inMonths} at ${time}, only when it is ${weekdayPhrase!.text}`
      : `${capitalize(dayPhrase!)} or every ${weekdayPhrase!.text}${inMonths} at ${time}`;
  }
  const everyMinutes = /^\*\/(\d+)$/u.exec(minute);
  if (everyMinutes) {
    const hourPhrase =
      hour === "*" ? "all day" : `during hours ${describeTokenField(hour, "hour")}`;
    const weekdayPhrase = describeDayOfWeek(weekday);
    const dayPhrase =
      weekdayPhrase === null
        ? ""
        : weekdayPhrase.periodic
          ? ` ${weekdayPhrase.text}`
          : ` on ${weekdayPhrase.text}`;
    const datePhrase = day === "*" ? "" : `, ${describeDayOfMonth(day) ?? day}`;
    const monthPhrase = describeMonth(month);
    return `Every ${everyMinutes[1]} minutes ${hourPhrase}${dayPhrase}${datePhrase}${
      monthPhrase ? ` in ${monthPhrase}` : ""
    }`;
  }
  const dateParts = [
    day === "*" ? null : `day of month ${describeTokenField(day, "day")}`,
    month === "*" ? null : `month ${describeTokenField(month, "month")}`,
    weekday === "*" ? null : `weekday ${describeTokenField(weekday, "weekday")}`,
  ].filter(Boolean);
  return `Runs when the minute is ${describeTokenField(minute, "minute")} and the hour is ${describeTokenField(hour, "hour")}${
    dateParts.length > 0 ? `, with ${joinNatural(dateParts as string[])}` : ""
  }`;
}

export function describeCronSchedule(
  expression: string,
  timezone: string,
  locale?: string
): string {
  const zone = canonicalCronTimeZone(timezone);
  return `${describeCronExpression(expression, locale)} in ${friendlyTimeZone(zone)} time`;
}

export function formatCronOccurrence(value: number, timezone: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: canonicalCronTimeZone(timezone),
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(value);
}

function describeNickname(expression: string): string | null {
  if (expression === "@hourly") return "At the start of every hour";
  if (expression === "@daily" || expression === "@midnight") return "Every day at midnight";
  if (expression === "@weekly") return "Every Sunday at midnight";
  if (expression === "@monthly") return "On the first day of every month at midnight";
  if (expression === "@yearly" || expression === "@annually") {
    return "Every January 1 at midnight";
  }
  return null;
}

function describeDayOfMonth(field: string): string | null {
  if (field === "*") return null;
  if (field === "L") return "on the last day of each month";
  const nearestWeekday = /^(\d{1,2})W$/u.exec(field);
  if (nearestWeekday) {
    return `on the weekday nearest the ${ordinal(Number(nearestWeekday[1]))} of each month`;
  }
  const exact = exactInteger(field, 1, 31);
  if (exact !== null) return `on the ${ordinal(exact)} of each month`;
  return `on calendar days ${describeTokenField(field, "day")}`;
}

function describeDayOfWeek(field: string): { text: string; periodic: boolean } | null {
  if (field === "*") return null;
  const normalized = field.startsWith("+") ? field.slice(1) : field;
  const nth = /^([A-Z]{3}|[0-7])#([1-5]|L)$/u.exec(normalized);
  if (nth) {
    const day = weekdayName(nth[1]!);
    const occurrence = nth[2] === "L" ? "last" : ordinalWord(Number(nth[2]!));
    return { text: `on the ${occurrence} ${day} of each month`, periodic: true };
  }
  const range = /^([A-Z]{3}|[0-7])-([A-Z]{3}|[0-7])$/u.exec(normalized);
  if (range) {
    return {
      text: `${weekdayName(range[1]!)} through ${weekdayName(range[2]!)}`,
      periodic: false,
    };
  }
  const values = normalized.split(",");
  if (values.every((value) => /^([A-Z]{3}|[0-7])$/u.test(value))) {
    return { text: joinNatural(values.map(weekdayName)), periodic: false };
  }
  return { text: describeTokenField(normalized, "weekday"), periodic: false };
}

function describeMonth(field: string): string | null {
  if (field === "*") return null;
  const range = /^([A-Z]{3}|\d{1,2})-([A-Z]{3}|\d{1,2})$/u.exec(field);
  if (range) return `${monthName(range[1]!)} through ${monthName(range[2]!)}`;
  const values = field.split(",");
  if (values.every((value) => /^([A-Z]{3}|\d{1,2})$/u.test(value))) {
    return joinNatural(values.map(monthName));
  }
  return describeTokenField(field, "month");
}

function describeTokenField(field: string, unit: string): string {
  if (field === "*") return `every ${unit}`;
  const step = /^\*\/(\d+)$/u.exec(field);
  if (step) return `every ${step[1]} ${unit}${step[1] === "1" ? "" : "s"}`;
  return field
    .replaceAll(",", ", ")
    .replaceAll("-", " through ")
    .replaceAll("/", " stepping by ")
    .replaceAll("#L", " last occurrence")
    .replace(/#([1-5])/gu, " occurrence $1")
    .replace(/^(\d{1,2})W$/u, "the weekday nearest $1");
}

function parseWeekdayList(field: string): number[] | null {
  const result: number[] = [];
  for (const value of field.split(",")) {
    const named = WEEKDAY_TOKENS.indexOf(value as (typeof WEEKDAY_TOKENS)[number]);
    const numeric = exactInteger(value, 0, 7);
    const day = named >= 0 ? named : numeric === 7 ? 0 : numeric;
    if (day === null || day < 0 || day > 6) return null;
    result.push(day);
  }
  return [...new Set(result)].sort(weekdayOrder);
}

function weekdayName(token: string): string {
  const named = WEEKDAY_TOKENS.indexOf(token as (typeof WEEKDAY_TOKENS)[number]);
  if (named >= 0) return WEEKDAYS[named]!;
  const numeric = Number(token) === 7 ? 0 : Number(token);
  return WEEKDAYS[numeric] ?? token;
}

function monthName(token: string): string {
  const named = MONTH_TOKENS.indexOf(token as (typeof MONTH_TOKENS)[number]);
  if (named >= 0) return MONTHS[named]!;
  return MONTHS[Number(token) - 1] ?? token;
}

function formatClockTime(hour: number, minute: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "UTC",
    hour: "numeric",
    minute: "2-digit",
  }).format(Date.UTC(2024, 0, 1, hour, minute));
}

function friendlyTimeZone(timezone: string): string {
  if (timezone === "UTC") return "UTC";
  return (timezone.split("/").at(-1) ?? timezone).replaceAll("_", " ");
}

function exactInteger(value: string, minimum: number, maximum: number): number | null {
  if (!/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}`);
  }
  return value;
}

function weekdayOrder(left: number, right: number): number {
  const order = [1, 2, 3, 4, 5, 6, 0];
  return order.indexOf(left) - order.indexOf(right);
}

function ordinal(value: number): string {
  const remainder = value % 100;
  if (remainder >= 11 && remainder <= 13) return `${value}th`;
  if (value % 10 === 1) return `${value}st`;
  if (value % 10 === 2) return `${value}nd`;
  if (value % 10 === 3) return `${value}rd`;
  return `${value}th`;
}

function ordinalWord(value: number): string {
  return ["", "first", "second", "third", "fourth", "fifth"][value] ?? ordinal(value);
}

function joinNatural(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
