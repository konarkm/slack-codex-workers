interface CronFieldSpec {
  min: number;
  max: number;
}

interface ParsedCronField {
  values: Set<number>;
  isWildcard: boolean;
}

interface CompiledCronSchedule {
  minute: ParsedCronField;
  hour: ParsedCronField;
  dayOfMonth: ParsedCronField;
  month: ParsedCronField;
  dayOfWeek: ParsedCronField;
  timeZone: string;
}

const FIELD_SPECS: CronFieldSpec[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 6 },
];

const weekdayMap: Record<string, number> = {
  sun: 0,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
};

export function validateCronSchedule(schedule: string): void {
  compileCronSchedule(schedule, "UTC");
}

export function findLatestMatchingCronMinute(
  schedule: string,
  timeZone: string,
  afterExclusive: Date,
  nowInclusive: Date,
): Date | null {
  const matcher = compileCronSchedule(schedule, timeZone);
  const end = floorToMinute(nowInclusive);
  const start = floorToMinute(afterExclusive);
  if (end.getTime() <= start.getTime()) return null;

  let cursor = end;
  while (cursor.getTime() > start.getTime()) {
    if (matchesSchedule(matcher, cursor)) {
      return cursor;
    }
    cursor = new Date(cursor.getTime() - 60_000);
  }
  return null;
}

function compileCronSchedule(schedule: string, timeZone: string): CompiledCronSchedule {
  validateTimezone(timeZone);
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("Cron schedule must have 5 fields: minute hour day-of-month month day-of-week.");
  }
  return {
    minute: parseField(parts[0]!, FIELD_SPECS[0]!),
    hour: parseField(parts[1]!, FIELD_SPECS[1]!),
    dayOfMonth: parseField(parts[2]!, FIELD_SPECS[2]!),
    month: parseField(parts[3]!, FIELD_SPECS[3]!),
    dayOfWeek: parseField(parts[4]!, FIELD_SPECS[4]!),
    timeZone,
  };
}

function matchesSchedule(schedule: CompiledCronSchedule, date: Date): boolean {
  const values = getZonedValues(date, schedule.timeZone);
  if (!schedule.minute.values.has(values.minute)) return false;
  if (!schedule.hour.values.has(values.hour)) return false;
  if (!schedule.month.values.has(values.month)) return false;

  const dayOfMonthMatches = schedule.dayOfMonth.values.has(values.dayOfMonth);
  const dayOfWeekMatches = schedule.dayOfWeek.values.has(values.dayOfWeek);
  if (schedule.dayOfMonth.isWildcard || schedule.dayOfWeek.isWildcard) {
    return dayOfMonthMatches && dayOfWeekMatches;
  }
  return dayOfMonthMatches || dayOfWeekMatches;
}

function parseField(value: string, spec: CronFieldSpec): ParsedCronField {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("Empty cron field.");
  }
  if (trimmed === "*") {
    return {
      values: buildWildcardSet(spec),
      isWildcard: true,
    };
  }

  const set = new Set<number>();
  for (const token of trimmed.split(",")) {
    parseToken(token.trim(), spec, set);
  }
  if (set.size === 0) {
    throw new Error(`Invalid cron field: ${value}`);
  }
  // As in Vixie cron, a field that starts with "*" (such as "*/2") counts as a wildcard for day-of-month/day-of-week matching.
  return {
    values: set,
    isWildcard: trimmed.startsWith("*"),
  };
}

function parseToken(token: string, spec: CronFieldSpec, set: Set<number>): void {
  if (!token) {
    throw new Error("Empty cron token.");
  }

  const [base, stepPart] = token.split("/");
  const step = stepPart ? parsePositiveInt(stepPart, "cron step") : 1;
  if (step < 1) {
    throw new Error("Cron step must be positive.");
  }

  if (base === "*") {
    addRange(spec.min, spec.max, step, set, spec);
    return;
  }

  if (base.includes("-")) {
    const [startRaw, endRaw] = base.split("-");
    const start = parsePositiveInt(startRaw, "cron range start");
    const end = parsePositiveInt(endRaw, "cron range end");
    addRange(start, end, step, set, spec);
    return;
  }

  const single = parsePositiveInt(base, "cron value");
  assertInRange(single, spec);
  set.add(single);
}

function addRange(start: number, end: number, step: number, set: Set<number>, spec: CronFieldSpec): void {
  assertInRange(start, spec);
  assertInRange(end, spec);
  if (end < start) {
    throw new Error("Cron range end must be >= start.");
  }
  for (let value = start; value <= end; value += step) {
    set.add(value);
  }
}

function assertInRange(value: number, spec: CronFieldSpec): void {
  if (value < spec.min || value > spec.max) {
    throw new Error(`Cron value ${value} is out of range ${spec.min}-${spec.max}.`);
  }
}

function parsePositiveInt(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return Number(value);
}

function buildWildcardSet(spec: CronFieldSpec): Set<number> {
  const set = new Set<number>();
  for (let value = spec.min; value <= spec.max; value += 1) {
    set.add(value);
  }
  return set;
}

function validateTimezone(value: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
  } catch {
    throw new Error(`Invalid timezone: ${value}`);
  }
}

function getZonedValues(date: Date, timeZone: string): {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    minute: "numeric",
    hour: "numeric",
    day: "numeric",
    month: "numeric",
    weekday: "short",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const record = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekday = weekdayMap[String(record.weekday ?? "").slice(0, 3).toLowerCase()];
  if (weekday === undefined) {
    throw new Error(`Could not resolve weekday in timezone ${timeZone}`);
  }
  return {
    minute: Number(record.minute),
    hour: Number(record.hour),
    dayOfMonth: Number(record.day),
    month: Number(record.month),
    dayOfWeek: weekday,
  };
}

function floorToMinute(value: Date): Date {
  return new Date(Math.floor(value.getTime() / 60_000) * 60_000);
}
