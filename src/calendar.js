// The shop's booked visits as a calendar feed (iCalendar, RFC 5545). The owner subscribes once in
// Google Calendar, Apple Calendar or Outlook, and every visit the receptionist books shows up there.

const esc = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const stamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

// Lines longer than 75 bytes are folded: a line break, then a space (RFC 5545 §3.1).
function fold(line) {
  const out = []; let cur = '', bytes = 0;
  for (const ch of line) {
    const n = Buffer.byteLength(ch);
    if (bytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch; bytes += n;
  }
  out.push(cur);
  return out.join('\r\n ');
}

/** The feed for one shop: its visits from the last 90 days onward. */
export function calendarFeed(client, bookings, { now = new Date(), brand = 'AfterHours Desk', pretty = (p) => p } = {}) {
  const hours = client.details?.schedule?.windowHours || 2;
  const since = now.getTime() - 90 * 86_400_000;
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${brand}//Visits//EN`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${esc(`${client.business} visits`)}`, 'X-PUBLISHED-TTL:PT1H', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
  ];
  for (const b of bookings) {
    if (b.kind !== 'booking' || !b.slot_start) continue;
    const start = new Date(b.slot_start);
    if (isNaN(start) || start.getTime() < since) continue;
    const name = b.caller_name || 'Customer';
    const desc = [
      b.issue && `Problem: ${b.issue}`,
      b.caller_phone && `Phone: ${pretty(b.caller_phone)}`,
      b.urgency && `Urgency: ${b.urgency}`,
      `Booked by your ${brand} receptionist on ${new Date(b.created_at).toUTCString().slice(0, 16)}.`,
    ].filter(Boolean).join('\n');
    lines.push('BEGIN:VEVENT',
      `UID:${b.id}@afterhours-desk`,
      `DTSTAMP:${stamp(b.created_at || now)}`,
      `DTSTART:${stamp(start)}`,
      `DTEND:${stamp(start.getTime() + hours * 3_600_000)}`,
      `SUMMARY:${esc(`${b.done_at ? '✓ ' : ''}Visit: ${name}${b.issue ? ` (${b.issue.slice(0, 60)})` : ''}`)}`,
      ...(b.address ? [`LOCATION:${esc(b.address)}`] : []),
      `DESCRIPTION:${esc(desc)}`,
      `STATUS:${b.done_at ? 'CONFIRMED' : 'TENTATIVE'}`,
      'END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}
