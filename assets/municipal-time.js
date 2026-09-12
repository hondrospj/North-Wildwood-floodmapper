/* Shared by the municipal archive viewer and comparison builder. */
(function (root) {
  "use strict";
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  });
  function municipalEpoch(value) {
    const text = String(value || "");
    if (/(?:Z|[+-]\d{2}:\d{2})$/.test(text)) return Date.parse(text.replace(" ", "T"));
    const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(text);
    if (!match) return NaN;
    const [, y, m, d, h, min, sec] = match;
    const wall = Date.UTC(+y, +m - 1, +d, +h, +min, +sec);
    const candidates = [4, 5].map(offset => wall + offset * 3600000).filter(stamp => {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(stamp)).map(p => [p.type, p.value]));
      return parts.year === y && parts.month === m && parts.day === d &&
        parts.hour === h && parts.minute === min && parts.second === sec;
    });
    // Missing spring-forward or repeated fall-back hours have no unique instant.
    return candidates.length === 1 ? candidates[0] : NaN;
  }
  root.NorthWildwoodTime = Object.freeze({ municipalEpoch });
})(globalThis);
