/**
 * A date format in the syntax of moment.js, which Obsidian plugins such as the Linter use: `YYYY-MM-DD HH:mm:ss`.
 * Only numeric tokens are supported, since names of months and weekdays depend on a locale.
 */
export class DateFormat {
  private constructor(
    readonly pattern: string,
    private readonly parts: Part[],
  ) {}

  /** The format for a pattern, or null when the pattern uses tokens that are not supported. */
  static parse(pattern: string): DateFormat | null {
    const parts: Part[] = [];
    let position = 0;
    while (position < pattern.length) {
      const char = pattern[position]!;
      if (char === "[") {
        const close = pattern.indexOf("]", position);
        if (close === -1) return null;
        parts.push({ literal: pattern.slice(position + 1, close) });
        position = close + 1;
      } else if (MOMENT_TOKEN_LETTERS.includes(char)) {
        let end = position;
        while (pattern[end] === char) end++;
        const token = pattern.slice(position, end);
        if (!isToken(token)) return null;
        parts.push({ token });
        position = end;
      } else {
        parts.push({ literal: char });
        position++;
      }
    }
    return new DateFormat(pattern, parts);
  }

  /** The date written in this format, in local time of the time zone. */
  format(date: Date, timeZone: string): string {
    const fields = fieldsIn(date, timeZone);
    return this.parts.map((part) => ("literal" in part ? part.literal : write(part.token, fields))).join("");
  }

  /** Whether the text is a valid date written exactly in this format. */
  matches(text: string): boolean {
    const fields: Partial<Record<Token, number>> = {};
    let rest = text;
    for (const part of this.parts) {
      if ("literal" in part) {
        if (!rest.startsWith(part.literal)) return false;
        rest = rest.slice(part.literal.length);
        continue;
      }
      const match = TOKEN_PATTERNS[part.token].exec(rest);
      if (!match) return false;
      fields[part.token] =
        part.token === "A" || part.token === "a" ? (/^pm$/i.test(match[0]) ? 1 : 0) : Number(match[0]);
      rest = rest.slice(match[0].length);
    }
    return rest === "" && isValid(fields);
  }
}

type Token = "YYYY" | "YY" | "MM" | "M" | "DD" | "D" | "HH" | "H" | "hh" | "h" | "mm" | "m" | "ss" | "s" | "A" | "a";
type Part = { token: Token } | { literal: string };

/** Letters that moment.js reads as (part of) a token. Other letters are written as they are. */
const MOMENT_TOKEN_LETTERS = "MQDdEewWYyGgAaHhkmsSzZXxNno";

const TOKEN_PATTERNS: Record<Token, RegExp> = {
  YYYY: /^\d{4}/,
  YY: /^\d{2}/,
  MM: /^\d{2}/,
  M: /^\d{1,2}/,
  DD: /^\d{2}/,
  D: /^\d{1,2}/,
  HH: /^\d{2}/,
  H: /^\d{1,2}/,
  hh: /^\d{2}/,
  h: /^\d{1,2}/,
  mm: /^\d{2}/,
  m: /^\d{1,2}/,
  ss: /^\d{2}/,
  s: /^\d{1,2}/,
  A: /^(AM|PM)/,
  a: /^(am|pm)/,
};

function isToken(text: string): text is Token {
  return text in TOKEN_PATTERNS;
}

type Fields = { year: number; month: number; day: number; hour: number; minute: number; second: number };

/** The time in ISO 8601 with the time zone's offset, such as `2026-10-22T09:15:00+02:00`. */
export function isoDateTime(date: Date, timeZone: string): string {
  const fields = fieldsIn(date, timeZone);
  const local = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second);
  const offset = Math.round((local - Math.floor(date.getTime() / 1000) * 1000) / 60_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  const sign = offset < 0 ? "-" : "+";
  const minutes = Math.abs(offset);
  const day = `${String(fields.year).padStart(4, "0")}-${pad(fields.month)}-${pad(fields.day)}`;
  const time = `${pad(fields.hour)}:${pad(fields.minute)}:${pad(fields.second)}`;
  return `${day}T${time}${sign}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

function fieldsIn(date: Date, timeZone: string): Fields {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)!.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

function write(token: Token, fields: Fields): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const hour12 = fields.hour % 12 === 0 ? 12 : fields.hour % 12;
  switch (token) {
    case "YYYY":
      return String(fields.year).padStart(4, "0");
    case "YY":
      return pad(fields.year % 100);
    case "MM":
      return pad(fields.month);
    case "M":
      return String(fields.month);
    case "DD":
      return pad(fields.day);
    case "D":
      return String(fields.day);
    case "HH":
      return pad(fields.hour);
    case "H":
      return String(fields.hour);
    case "hh":
      return pad(hour12);
    case "h":
      return String(hour12);
    case "mm":
      return pad(fields.minute);
    case "m":
      return String(fields.minute);
    case "ss":
      return pad(fields.second);
    case "s":
      return String(fields.second);
    case "A":
      return fields.hour < 12 ? "AM" : "PM";
    case "a":
      return fields.hour < 12 ? "am" : "pm";
  }
}

function isValid(fields: Partial<Record<Token, number>>): boolean {
  const month = fields.MM ?? fields.M;
  const day = fields.DD ?? fields.D;
  const year = fields.YYYY ?? (fields.YY === undefined ? 2000 : 2000 + fields.YY);
  const hour24 = fields.HH ?? fields.H;
  const hour12 = fields.hh ?? fields.h;
  if (month !== undefined && (month < 1 || month > 12)) return false;
  if (day !== undefined && (day < 1 || day > new Date(Date.UTC(year, month ?? 1, 0)).getUTCDate())) return false;
  if (hour24 !== undefined && hour24 > 23) return false;
  if (hour12 !== undefined && (hour12 < 1 || hour12 > 12)) return false;
  const minute = fields.mm ?? fields.m;
  const second = fields.ss ?? fields.s;
  return (minute === undefined || minute < 60) && (second === undefined || second < 60);
}
