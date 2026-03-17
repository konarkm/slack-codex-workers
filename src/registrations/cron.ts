interface CronFieldSpec {
  min: number;
  max: number;
}

const FIELD_SPECS: CronFieldSpec[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 6 },
];

export function findLatestMatchingCronMinute(schedule: string, afterExclusive: Date, nowInclusive: Date): Date | null {
  const matcher = compileCronSchedule(schedule);
  const end = floorToMinute(nowInclusive);
  const start = floorToMinute(afterExclusive);
  if (end.getTime() <= start.getTime()) return null;

  let cursor = end;
  while (cursor.getTime() > start.getTime()) {
    if (matcher(cursor)) {
      return cursor;
    }
    cursor = new Date(cursor.getTime() - 60_000);
  }
  return null;
}

function compileCronSchedule(schedule: string): (date: Date) => boolean {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error("Cron schedule must have 5 fields: minute hour day-of-month month day-of-week.");
  }
  const sets = parts.map((part, index) => parseField(part, FIELD_SPECS[index]!));
  return (date: Date) => {
    const values = [
      date.getUTCMinutes(),
      date.getUTCHours(),
      date.getUTCDate(),
      date.getUTCMonth() + 1,
      date.getUTCDay(),
    ];
    return sets.every((set, index) => set.has(values[index]!));
  };
}

function parseField(value: string, spec: CronFieldSpec): Set<number> {
  const set = new Set<number>();
  for (const token of value.split(",")) {
    parseToken(token.trim(), spec, set);
  }
  if (set.size === 0) {
    throw new Error(`Invalid cron field: ${value}`);
  }
  return set;
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

function floorToMinute(value: Date): Date {
  return new Date(Date.UTC(
    value.getUTCFullYear(),
    value.getUTCMonth(),
    value.getUTCDate(),
    value.getUTCHours(),
    value.getUTCMinutes(),
    0,
    0,
  ));
}
