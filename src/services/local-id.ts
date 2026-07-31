export function slugifyLabel(input: string, fallback: string, maxLength?: number): string {
  let slug = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (maxLength !== undefined) {
    slug = slug.slice(0, maxLength).replace(/-+$/g, "");
  }
  return slug || fallback;
}

export function formatUtcCodexRunTimestamp(date: Date): string {
  return `${utcDate(date)}T${utcTime(date)}Z`;
}

export function formatUtcWorkSessionTimestamp(date: Date): string {
  return `${utcDate(date).replaceAll("-", "")}-${utcTime(date)}`;
}

export function formatLocalHandoffMinuteTimestamp(date: Date): string {
  return `${localDate(date)}-${localHourMinute(date)}`;
}

function utcDate(date: Date): string {
  return [
    date.getUTCFullYear(),
    pad2(date.getUTCMonth() + 1),
    pad2(date.getUTCDate())
  ].join("-");
}

function utcTime(date: Date): string {
  return [
    pad2(date.getUTCHours()),
    pad2(date.getUTCMinutes()),
    pad2(date.getUTCSeconds())
  ].join("");
}

function localDate(date: Date): string {
  return [
    date.getFullYear(),
    pad2(date.getMonth() + 1),
    pad2(date.getDate())
  ].join("-");
}

function localHourMinute(date: Date): string {
  return [
    pad2(date.getHours()),
    pad2(date.getMinutes())
  ].join("");
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
