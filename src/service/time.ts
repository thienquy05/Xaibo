// Agent timestamps to UTC ms (P3-T12, EC-42, §5.11). Only an ISO 8601 date-time (`T` or space separator) with an explicit
// `Z`, `±hh:mm` or `±hhmm` offset is accepted: JS reads an offset-less date-time as local time, which would make stored
// times depend on TZ and DST. Such a timestamp, or anything else, is unknown (NaN): never guessed (D-P3-11).
const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i;

export const utcMs = (x: unknown): number => (typeof x === 'string' && ISO_WITH_OFFSET.test(x) ? Date.parse(x) : Number.NaN);
