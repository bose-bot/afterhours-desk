// Works out open appointment windows from a client's weekly hours, in the client's own time zone.

const pad = (n) => String(n).padStart(2, '0');

// The wall-clock parts of a UTC instant in a given time zone.
function zonedParts(date, timeZone) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, min: +p.minute, s: +p.second, weekday };
}

// The UTC instant for a wall-clock time in a time zone (handles daylight saving).
export function zonedToUtc(y, m, d, h, min, timeZone) {
  let guess = Date.UTC(y, m - 1, d, h, min);
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess), timeZone);
    const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min);
    const target = Date.UTC(y, m - 1, d, h, min);
    const diff = target - asUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

function label(start, end, timeZone) {
  const day = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'long', month: 'long', day: 'numeric' }).format(start);
  const t = (x) => new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(x).replace(':00', '');
  return `${day}, ${t(start)} to ${t(end)}`;
}

/**
 * Lists appointment windows from now on.
 * schedule: { days: [0-6], start: "08:00", end: "17:00", windowHours: 2, timezone }
 * booked: Set of ISO start times already taken.
 */
export function openSlots(schedule, { now = new Date(), booked = new Set(), daysAhead = 7, limit = 6, leadMinutes = 60 } = {}) {
  const { days, start, end, windowHours = 2, timezone } = schedule;
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const earliest = now.getTime() + leadMinutes * 60_000;
  const today = zonedParts(now, timezone);
  const out = [];

  for (let offset = 0; offset <= daysAhead && out.length < limit; offset++) {
    // Walk calendar days in the client's zone; noon avoids DST edge cases while stepping.
    const noon = zonedToUtc(today.y, today.m, today.d, 12, 0, timezone).getTime() + offset * 86_400_000;
    const p = zonedParts(new Date(noon), timezone);
    if (!days.includes(p.weekday)) continue;

    const dayEndMin = eh * 60 + em;
    for (let m = sh * 60 + sm; m + windowHours * 60 <= dayEndMin && out.length < limit; m += windowHours * 60) {
      const s = zonedToUtc(p.y, p.m, p.d, Math.floor(m / 60), m % 60, timezone);
      const e = new Date(s.getTime() + windowHours * 3_600_000);
      const iso = s.toISOString();
      if (s.getTime() < earliest || booked.has(iso)) continue;
      out.push({ slot_start: iso, label: label(s, e, timezone) });
    }
  }
  return out;
}

export function describeSchedule(schedule) {
  const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const d = schedule.days;
  const days = d.length === 7 ? 'Every day' : d.length === 5 && !d.includes(0) && !d.includes(6) ? 'Mon–Fri'
    : d.length === 6 && !d.includes(0) ? 'Mon–Sat' : d.map((x) => names[x]).join(', ');
  const t = (hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    const h12 = ((h + 11) % 12) + 1;
    return `${h12}${m ? ':' + pad(m) : ''}${h < 12 ? 'am' : 'pm'}`;
  };
  return `${days} ${t(schedule.start)}–${t(schedule.end)}`;
}
