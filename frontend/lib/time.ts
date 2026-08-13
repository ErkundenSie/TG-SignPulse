import { useEffect, useState } from "react";
import { getToken } from "./auth";
import { getGlobalSettings } from "./api";

export const DEFAULT_TIMEZONE = "Asia/Shanghai";

const TIMESTAMP_WITH_ZONE = /(?:Z|[+-]\d{2}:\d{2})$/i;

const toDate = (value: string | Date) => {
  if (value instanceof Date) return value;
  return new Date(TIMESTAMP_WITH_ZONE.test(value) ? value : `${value}Z`);
};

export const formatConfiguredDateTime = (
  value: string | Date | null | undefined,
  timezone: string,
  locale = "zh-CN",
  options: Intl.DateTimeFormatOptions = {},
) => {
  if (!value) return "--";
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const format = (timeZone: string) =>
    new Intl.DateTimeFormat(locale, {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      ...options,
    }).format(date);
  try {
    return format(timezone);
  } catch {
    return format(DEFAULT_TIMEZONE);
  }
};

export const toConfiguredDateTimeLocal = (
  value: string | null | undefined,
  timezone: string,
) => {
  if (!value) return "";
  const date = toDate(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || DEFAULT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
};

const timezoneOffsetMs = (date: Date, timezone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const renderedUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return renderedUtc - date.getTime();
};

export const configuredDateTimeLocalToIso = (
  value: string,
  timezone: string,
) => {
  const localMillis = Date.parse(`${value}:00Z`);
  if (Number.isNaN(localMillis)) return "";
  try {
    let utcMillis =
      localMillis -
      timezoneOffsetMs(new Date(localMillis), timezone || DEFAULT_TIMEZONE);
    utcMillis =
      localMillis -
      timezoneOffsetMs(new Date(utcMillis), timezone || DEFAULT_TIMEZONE);
    return new Date(utcMillis).toISOString();
  } catch {
    return new Date(localMillis).toISOString();
  }
};

export const useConfiguredTimezone = () => {
  const [timezone, setTimezone] = useState(DEFAULT_TIMEZONE);

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    getGlobalSettings(token)
      .then((settings) => setTimezone(settings.timezone || DEFAULT_TIMEZONE))
      .catch(() => setTimezone(DEFAULT_TIMEZONE));
  }, []);

  return timezone;
};
