import { test } from 'node:test';
import assert from 'node:assert/strict';
import { welcomeEmail, callSummaryEmail } from '../src/emails.js';

const config = { brandName: 'AfterHours Desk' };
const client = { business: 'Maple Row Heating & Air', contact: 'Pat', email: 'pat@shop.example', phoneNumber: '+15139824409' };

test('welcome email shows the number big, with a call button and the next steps', () => {
  const m = welcomeEmail(config, client);
  assert.equal(m.to, 'pat@shop.example');
  assert.match(m.html, /\(513\) 982-4409/);
  assert.match(m.html, /href="tel:\+15139824409"/);
  assert.match(m.html, /Maple Row Heating &amp; Air now answers every call\./);
  assert.match(m.html, /Forward your missed calls/);
  assert.match(m.text, /Its phone number is \(513\) 982-4409\./, 'plain-text version kept for mail apps that want it');
});

test('welcome email without a number yet says it is on the way', () => {
  const m = welcomeEmail(config, { ...client, phoneNumber: null });
  assert.match(m.html, /being activated/);
  assert.doesNotMatch(m.html, /Call it now/);
});

test('call summary puts the booking first, with urgency and a call-back button', () => {
  const items = [{ kind: 'booking', slot_label: 'Wednesday, November 4, 8 AM to 10 AM', caller_name: 'Dana Ruiz', caller_phone: '+15135550182', address: '14 Elm St, Mason', issue: 'Furnace blowing cold', urgency: 'Priority' }];
  const m = callSummaryEmail(config, client, { items, callerPhone: '+15135550182', summary: 'Booked a furnace repair.' });
  assert.equal(m.subject, 'Call summary: Dana Ruiz');
  assert.match(m.html, /Booked: Wednesday, November 4, 8 AM to 10 AM/);
  assert.match(m.html, />Priority</);
  assert.match(m.html, /Call Dana Ruiz back/);
  assert.match(m.html, /\(513\) 555-0182/);
  assert.doesNotMatch(m.html, /Emergency call\./);
});

test('emergency calls get a red banner and an EMERGENCY subject', () => {
  const items = [{ kind: 'message', caller_name: 'Sam', caller_phone: '5135550999', issue: 'Gas smell', urgency: 'Emergency' }];
  const m = callSummaryEmail(config, client, { items, callerPhone: '+15135550999', summary: 'Told to leave.' });
  assert.match(m.subject, /^EMERGENCY · /);
  assert.match(m.html, /Emergency call\. The caller was told to leave/);
  assert.match(m.html, /Emergency: call back/);
});

test('anything a caller said is escaped, so it cannot inject HTML into the email', () => {
  const evil = '<img src=x onerror=alert(1)><a href="https://phish.example">click</a>';
  const items = [{ kind: 'message', caller_name: evil, caller_phone: '1', issue: evil, urgency: 'Routine' }];
  const m = callSummaryEmail(config, client, { items, callerPhone: '1', summary: evil });
  assert.doesNotMatch(m.html, /<img src=x/);
  assert.doesNotMatch(m.html, /<a href="https:\/\/phish/);
  assert.match(m.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
});
