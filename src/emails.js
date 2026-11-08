import { ownerUrl } from './owner.js';
// Emails sent to shop owners, as designed HTML plus a plain-text version for clients that want it.
// Everything that came from a caller or a form is escaped before it goes into HTML.

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export { prettyPhone } from './phone.js';
import { prettyPhone } from './phone.js';

// Same palette as the website: night blue, furnace orange, cold-air blue.
const C = { night: '#0D1621', panel: '#132131', line: '#263B51', ink: '#E9EFF3', dim: '#9AABB9', heat: '#FF8A3D', cool: '#5CC8FF', crit: '#FF9488', ok: '#74E0A9' };
const FONT = "'Archivo','Helvetica Neue',Helvetica,Arial,sans-serif";
const URGENCY = { Emergency: C.crit, Priority: C.heat, Routine: C.ok };

function shell({ brand, preheader, body }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><meta name="supported-color-schemes" content="dark"><title>${esc(brand)}</title></head>
<body style="margin:0;padding:0;background:${C.night};">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.night};">
<tr><td align="center" style="padding:28px 14px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;font-family:${FONT};color:${C.ink};">
<tr><td style="padding:0 6px 22px;font-size:17px;font-weight:800;letter-spacing:-.01em;"><span style="color:${C.heat};">&#9679;</span>&nbsp; ${esc(brand)}</td></tr>
${body}
<tr><td style="padding:26px 6px 0;font-size:12.5px;line-height:1.6;color:#6E8295;">You get this because your shop uses ${esc(brand)}. Reply to this email to change anything your receptionist says.</td></tr>
</table></td></tr></table></body></html>`;
}

// A quiet link to the owner's dashboard, shown at the bottom of every email when the server can make one.
const dashButton = (url) => url ? `<tr><td style="padding:4px 0 6px;"><a href="${esc(url)}" style="display:inline-block;border:1px solid ${C.cool};color:${C.cool};font-weight:700;font-size:14.5px;text-decoration:none;padding:11px 20px;border-radius:999px;">Open your dashboard</a></td></tr>` : '';

const panel = (inner, border = C.line) => `<tr><td style="background:${C.panel};border:1px solid ${border};border-radius:18px;padding:26px 24px;">${inner}</td></tr><tr><td style="height:14px;"></td></tr>`;

export function welcomeEmail(config, client) {
  const brand = config.brandName;
  const n = client.phoneNumber ? prettyPhone(client.phoneNumber) : null;
  const text = `Hi ${client.contact},

Your AI receptionist for ${client.business} is set up.

${n ? `Its phone number is ${n}.` : 'Its phone number is being activated and will be emailed to you shortly.'}

What to do next:
1. Call ${n || 'the number'} yourself and pretend to be a customer. Try booking a visit, and try "I smell gas" to hear the safety response.
2. Set your business line to forward calls to it when you're busy or closed. Most carriers call this "conditional call forwarding" (forward on busy / no answer). Your carrier's support page or app will show how.
3. Reply to this email with anything it should say differently.

New bookings and messages will be sent to this address, with a summary each morning at 7.
${ownerUrl(config, client) ? `\nYour dashboard (bookmark it): ${ownerUrl(config, client)}\n` : ''}
${brand}`;

  const steps = [
    ['Call it yourself', `Pretend to be a customer. Book a visit, then call again and say "I smell gas" to hear the safety response.`],
    ['Forward your missed calls', `Set your business line to forward to it when you're busy or closed. Carriers call this conditional call forwarding.`],
    ['Tell us what to change', 'Reply to this email with anything it should say differently.'],
  ].map(([h, p], i) => `<tr><td valign="top" style="width:40px;padding:0 0 18px;font-size:26px;font-weight:800;color:${C.heat};line-height:1;">${i + 1}</td><td style="padding:0 0 18px;"><div style="font-size:16px;font-weight:700;margin-bottom:4px;">${esc(h)}</div><div style="font-size:14.5px;line-height:1.55;color:${C.dim};">${esc(p)}</div></td></tr>`).join('');

  const tel = client.phoneNumber ? `tel:${esc(client.phoneNumber)}` : '';
  const body = panel(`
    <div style="font-size:14px;color:${C.ok};font-weight:700;margin-bottom:10px;">Your receptionist is live</div>
    <div style="font-size:30px;line-height:1.1;font-weight:800;letter-spacing:-.02em;margin-bottom:18px;">${esc(client.business)} now answers every call.</div>
    ${n ? `<div style="font-size:14px;color:${C.dim};margin-bottom:6px;">Its phone number</div>
    <div style="font-size:40px;line-height:1;font-weight:800;color:${C.cool};letter-spacing:-.01em;margin-bottom:22px;">${esc(n)}</div>
    <a href="${tel}" style="display:inline-block;background:${C.heat};color:#1C0D02;font-weight:800;font-size:16px;text-decoration:none;padding:14px 26px;border-radius:999px;">Call it now</a>`
    : `<div style="font-size:16px;color:${C.dim};">Its phone number is being activated. We'll email it to you in a few minutes.</div>`}
  `, C.heat) + panel(`
    <div style="font-size:18px;font-weight:800;margin-bottom:18px;">Next steps</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${steps}</table>
    <div style="font-size:14px;color:${C.dim};border-top:1px solid ${C.line};padding-top:16px;">Hi ${esc(client.contact)}, every booking and message will be emailed to this address right after the call, with a summary each morning at 7. Your dashboard shows all of them in one place.</div>
  `) + dashButton(ownerUrl(config, client));

  return {
    to: client.email,
    subject: `Your ${brand} receptionist is live`,
    text,
    html: shell({ brand, preheader: n ? `${client.business} is live at ${n}.` : `${client.business} is set up.`, body }),
  };
}

/** items: bookings/messages saved during this call (rows from the bookings table). */
export function callSummaryEmail(config, client, { items, callerPhone, summary, late = false }) {
  const brand = config.brandName;
  const urgent = items.some((b) => b.urgency === 'Emergency');
  const who = items[0]?.caller_name || callerPhone || 'new caller';
  const lines = items.map((b) => b.kind === 'booking'
    ? `BOOKED ${b.slot_label}: ${b.caller_name} ${b.caller_phone} | ${b.address} | ${b.issue} [${b.urgency}]`
    : `MESSAGE [${b.urgency}]: ${b.caller_name || 'Unknown'} ${b.caller_phone || callerPhone} | ${b.issue}`);
  const lateNote = 'This report arrived late because our server could not be reached when the call ended. If the caller asked for a booking, check the summary and call them to confirm.';
  const dash = ownerUrl(config, client);
  const text = `${late ? lateNote + '\n\n' : ''}${lines.length ? lines.join('\n') + '\n\n' : ''}Caller: ${callerPhone || 'unknown'}\n\nSummary:\n${summary || '(no summary)'}\n${dash ? `\nDashboard: ${dash}\n` : ''}`;

  const cards = items.map((b) => {
    const color = URGENCY[b.urgency] || C.dim;
    const title = b.kind === 'booking' ? `Booked: ${b.slot_label || ''}` : (b.urgency === 'Emergency' ? 'Emergency: call back' : 'Callback requested');
    const phone = b.caller_phone || callerPhone;
    const rows = [
      ['Caller', b.caller_name || 'Unknown'],
      ['Phone', prettyPhone(phone) || phone || 'Unknown'],
      ...(b.address ? [['Address', b.address]] : []),
      ['Problem', b.issue || 'Not given'],
    ].map(([k, v]) => `<tr><td style="padding:5px 12px 5px 0;font-size:13.5px;color:${C.dim};width:80px;vertical-align:top;">${esc(k)}</td><td style="padding:5px 0;font-size:15px;">${esc(v)}</td></tr>`).join('');
    return panel(`
      <span style="display:inline-block;font-size:12.5px;font-weight:800;color:${color};border:1px solid ${color};border-radius:999px;padding:3px 10px;margin-bottom:12px;">${esc(b.urgency || 'Routine')}</span>
      <div style="font-size:22px;font-weight:800;line-height:1.2;margin-bottom:14px;">${esc(title)}</div>
      <table role="presentation" cellpadding="0" cellspacing="0">${rows}</table>
      ${phone ? `<a href="tel:${esc(phone)}" style="display:inline-block;margin-top:16px;background:${b.urgency === 'Emergency' ? C.crit : C.heat};color:#1C0D02;font-weight:800;font-size:15px;text-decoration:none;padding:12px 22px;border-radius:999px;">Call ${esc(b.caller_name || 'them')} back</a>` : ''}
    `, b.urgency === 'Emergency' ? C.crit : C.line);
  }).join('');

  const body = (late ? panel(`<div style="font-size:15px;line-height:1.6;color:${C.ink};">${esc(lateNote)}</div>`, C.heat) : '')
    + (urgent ? `<tr><td style="background:${C.crit};color:#2A0905;border-radius:14px;padding:14px 18px;font-size:15px;font-weight:800;">Emergency call. The caller was told to leave and call 911 or the gas company.</td></tr><tr><td style="height:14px;"></td></tr>` : '')
    + (cards || panel(`<div style="font-size:20px;font-weight:800;margin-bottom:8px;">A caller reached your receptionist</div><div style="font-size:15px;color:${C.dim};">No booking or message was left. The summary is below.</div>`))
    + panel(`
      <div style="font-size:14px;color:${C.dim};margin-bottom:8px;">What happened on the call</div>
      <div style="font-size:15.5px;line-height:1.6;">${esc(summary || 'No summary was recorded for this call.')}</div>
      <div style="font-size:13px;color:#6E8295;margin-top:14px;">Caller ID: ${esc(prettyPhone(callerPhone) || callerPhone || 'unknown')}</div>
    `) + dashButton(ownerUrl(config, client));

  return {
    to: client.email,
    subject: `${urgent ? 'EMERGENCY · ' : ''}Call summary: ${who}`,
    text,
    html: shell({ brand, preheader: lines[0] || `Call from ${callerPhone || 'a caller'}`, body }),
  };
}

/** The 7 AM email: calls to return first, then visits booked, then a count of every call. */
export function morningReportEmail(config, client, { calls, callbacks, booked }) {
  const brand = config.brandName;
  const dash = ownerUrl(config, client);
  const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
  const headline = [plural(calls.length, 'call'), booked.length ? `${booked.length} booked` : '', callbacks.length ? `${callbacks.length} to call back` : ''].filter(Boolean).join(', ');
  const urgentCount = callbacks.filter((b) => b.urgency === 'Emergency' || b.urgency === 'Priority').length;

  const textLines = [
    `Good morning ${client.contact}. Since the last report, ${client.business} got ${headline}.`, '',
    ...(callbacks.length ? ['CALL BACK TODAY', ...callbacks.map((b) => `- [${b.urgency || 'Routine'}] ${b.caller_name || 'Unknown'} ${b.caller_phone || ''}: ${b.issue || ''}`), ''] : []),
    ...(booked.length ? ['BOOKED', ...booked.map((b) => `- ${b.slot_label}: ${b.caller_name || ''} ${b.caller_phone || ''}, ${b.address || ''} (${b.issue || ''})`), ''] : []),
    ...(dash ? [`Everything is on your dashboard: ${dash}`] : []),
  ];

  const row = (b, kind) => {
    const color = URGENCY[b.urgency] || C.dim;
    const phone = b.caller_phone;
    const top = kind === 'booking' ? esc(b.slot_label || '') : `<span style="color:${color};font-weight:800;">${esc(b.urgency || 'Routine')}</span>`;
    return `<tr><td style="padding:14px 0;border-top:1px solid ${C.line};">
      <div style="font-size:13px;color:${C.dim};margin-bottom:4px;">${top}</div>
      <div style="font-size:16px;font-weight:700;">${esc(b.caller_name || 'Unknown caller')}${b.address ? ` <span style="font-weight:400;color:${C.dim};">· ${esc(b.address)}</span>` : ''}</div>
      <div style="font-size:14.5px;color:${C.ink};margin-top:2px;">${esc(b.issue || '')}</div>
      ${phone ? `<a href="tel:${esc(phone)}" style="display:inline-block;margin-top:6px;color:${C.heat};font-weight:700;font-size:14.5px;text-decoration:none;">${esc(prettyPhone(phone) || phone)}</a>` : ''}
    </td></tr>`;
  };
  const tile = (n, label, color) => `<td style="width:33%;padding:0 6px 0 0;"><div style="background:${C.night};border:1px solid ${C.line};border-radius:14px;padding:14px;"><div style="font-size:30px;font-weight:800;color:${color};line-height:1;">${n}</div><div style="font-size:13px;color:${C.dim};margin-top:6px;">${label}</div></div></td>`;

  const body = panel(`
      <div style="font-size:14px;color:${C.cool};font-weight:700;margin-bottom:10px;">Morning report</div>
      <div style="font-size:26px;line-height:1.15;font-weight:800;letter-spacing:-.02em;margin-bottom:18px;">Good morning, ${esc(client.contact)}. Here's what came in.</div>
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${tile(calls.length, 'calls answered', C.ink)}${tile(booked.length, 'visits booked', C.ok)}${tile(callbacks.length, 'to call back', callbacks.length ? C.heat : C.dim)}</tr></table>
    `, urgentCount ? C.heat : C.line)
    + (callbacks.length ? panel(`<div style="font-size:18px;font-weight:800;margin-bottom:6px;">Call back today</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${callbacks.map((b) => row(b, 'message')).join('')}</table>`, urgentCount ? C.heat : C.line) : '')
    + (booked.length ? panel(`<div style="font-size:18px;font-weight:800;margin-bottom:6px;">Booked</div><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${booked.map((b) => row(b, 'booking')).join('')}</table>`) : '')
    + dashButton(dash);

  return {
    to: client.email,
    subject: `${urgentCount ? 'Urgent callbacks · ' : ''}Overnight at ${client.business}: ${headline}`,
    text: textLines.join('\n'),
    html: shell({ brand, preheader: `${headline}.`, body }),
  };
}
