/**
 * Dates and times in the admin, in the site's time zone (default UTC), formatted the same on the server
 * and in the browser: the SSR'd admin tables would otherwise render in the Worker's locale and UTC
 * and differ from the client's first render (React hydration error #418). Only numeric parts come
 * from Intl (they don't vary between ICU builds); the month names and layout are fixed here.
 */

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const FORMATS = new Map<string, Intl.DateTimeFormat>();

const partsFor = (timeZone: string): Intl.DateTimeFormat => {
  let f = FORMATS.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    });
    FORMATS.set(timeZone, f);
  }
  return f;
};

/** "2 Oct 2026, 09:05" in `timeZone` (IANA, default UTC). */
export function formatDateTime(
  at: string | number | Date,
  timeZone = "UTC"
): string {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  const p = Object.fromEntries(
    partsFor(timeZone)
      .formatToParts(date)
      .map((x) => [x.type, x.value])
  );
  const hour = String(Number(p.hour) % 24).padStart(2, "0");
  return `${Number(p.day)} ${MONTHS[Number(p.month) - 1]} ${p.year}, ${hour}:${(p.minute ?? "").padStart(2, "0")}`;
}
