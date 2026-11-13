// Every country the receptionist works in, as data: the trade, safety numbers, urgent cases, languages,
// work week, phone-number route and how calls are recognised. Adding a country = adding an entry here.
// The US text is the original script, word for word.

// How a shop in each country gets its phone number:
//   vapi-then-twilio  free Vapi number, Twilio when those run out (US)
//   twilio            buy a local Twilio number (some countries need a regulatory bundle first)
//   sip               a licensed local provider, connected to Vapi as a SIP credential, attached by the operator

const ENGLISH = { code: 'en', label: 'English', transcriber: { provider: 'deepgram', model: 'nova-3', language: 'en' } };

export const COUNTRIES = {
  US: {
    code: 'US', name: 'United States', dial: '1', timezone: 'America/New_York', currency: 'USD', locale: 'en-US',
    timezones: [['America/New_York', 'Eastern'], ['America/Chicago', 'Central'], ['America/Denver', 'Mountain'], ['America/Phoenix', 'Arizona'], ['America/Los_Angeles', 'Pacific'], ['America/Anchorage', 'Alaska'], ['Pacific/Honolulu', 'Hawaii']],
    numberRoute: 'vapi-then-twilio', areaCodes: true, workWeek: 'mon-fri',
    trade: 'a heating and air conditioning company',
    greeting: (b) => `Thanks for calling ${b}, this is the virtual assistant.`,
    safety: () => 'Please leave the building right away and call 911 or your gas company from outside. Your safety comes first.',
    urgent: 'No heat in freezing weather, no AC in extreme heat with elderly people, infants or medical needs, or water leaking from the unit',
    basicCheck: 'check that the thermostat is set correctly and the breaker hasn\'t tripped.',
    outsideArea: 'suggest they search for a local HVAC provider',
    defaultServices: 'furnace and AC repair, maintenance tune-ups, new system estimates',
    collect: 'service address with city or ZIP, and confirm it is in the service area; what is going on (furnace, heat pump, central AC, boiler or thermostat, age of unit, what they notice)',
    language: '', languages: [], examples: 'us',
  },
  CA: {
    code: 'CA', name: 'Canada', dial: '1', timezone: 'America/Toronto', currency: 'CAD', locale: 'en-CA',
    timezones: [['America/Toronto', 'Eastern'], ['America/Halifax', 'Atlantic'], ['America/St_Johns', 'Newfoundland'], ['America/Winnipeg', 'Central'], ['America/Regina', 'Saskatchewan'], ['America/Edmonton', 'Mountain'], ['America/Vancouver', 'Pacific']],
    numberRoute: 'twilio', areaCodes: true, workWeek: 'mon-fri',
    trade: 'a heating and air conditioning company',
    greeting: (b) => `Thanks for calling ${b}, this is the virtual assistant.`,
    safety: (d) => `Please leave the building right away and call 911${d?.gasline ? ` or the gas company on ${spoken(d.gasline)}` : ' or your gas utility\'s emergency line'} from outside. Your safety comes first.`,
    urgent: 'No heat in freezing weather, no AC in extreme heat with elderly people, infants or medical needs, or water leaking from the unit',
    basicCheck: 'check that the thermostat is set correctly and the breaker hasn\'t tripped.',
    outsideArea: 'suggest they search for a local HVAC provider',
    defaultServices: 'furnace, boiler and AC repair, maintenance tune-ups, heat pumps, new system estimates',
    collect: 'service address with city or postal code, and confirm it is in the service area; what is going on (furnace, heat pump, boiler, central AC or thermostat, age of unit, what they notice)',
    language: '', examples: 'us',
    // English, or English and French on the same call (Quebec, New Brunswick, Ottawa).
    languages: [ENGLISH, { code: 'en-fr', label: 'English and French', transcriber: { provider: 'deepgram', model: 'nova-3', language: 'multi' },
      rule: 'LANGUAGE\nCallers may speak English or French. Reply in the language the caller uses.\n\n' }],
  },
  GB: {
    code: 'GB', name: 'United Kingdom', dial: '44', timezone: 'Europe/London', currency: 'GBP', locale: 'en-GB',
    timezones: [['Europe/London', 'UK time']],
    numberRoute: 'twilio', bundleRequired: true, workWeek: 'mon-fri',
    trade: 'a heating, boiler and air conditioning company',
    greeting: (b) => `Thanks for calling ${b}, this is the virtual assistant.`,
    // National Gas Emergency Service covers England, Scotland and Wales; 999 for anyone unwell.
    safety: (d) => `Please leave the property right away and call the gas emergency line on ${d?.gasline ? spoken(d.gasline) : '0800 111 999'} from outside, or 999 if anyone feels unwell. Your safety comes first.`,
    urgent: 'No heating or hot water in cold weather with elderly people, infants or medical needs, or water leaking from the boiler',
    basicCheck: 'check that the thermostat is turned up and the boiler has power.',
    outsideArea: 'suggest they search for a local Gas Safe registered engineer',
    defaultServices: 'boiler repair and servicing, central heating, heat pumps, air conditioning',
    collect: 'service address with town and postcode, and confirm it is in the service area; what is going on (boiler, radiators, heat pump, air conditioning or thermostat, age of the system, what they notice)',
    language: '', languages: [], examples: 'gb',
  },
  AU: {
    code: 'AU', name: 'Australia', dial: '61', timezone: 'Australia/Sydney', currency: 'AUD', locale: 'en-AU',
    timezones: [['Australia/Sydney', 'NSW, ACT, Victoria, Tasmania'], ['Australia/Brisbane', 'Queensland'], ['Australia/Adelaide', 'South Australia'], ['Australia/Darwin', 'Northern Territory'], ['Australia/Perth', 'Western Australia']],
    numberRoute: 'twilio', bundleRequired: true, workWeek: 'mon-fri',
    trade: 'an air conditioning and heating company',
    greeting: (b) => `Thanks for calling ${b}, this is the virtual assistant.`,
    safety: (d) => `Please leave the building right away and call 000 from outside${d?.gasline ? `, then the gas emergency line on ${spoken(d.gasline)}` : ', then your gas distributor\'s emergency line'}. Your safety comes first.`,
    urgent: 'No cooling in a heatwave with elderly people, infants or medical needs, no heating in cold weather, or water leaking from the unit',
    basicCheck: 'check that the remote is set to cool or heat and the circuit breaker hasn\'t tripped.',
    outsideArea: 'suggest they search for a local air conditioning technician',
    defaultServices: 'split system and ducted air con service and repair, installation, gas heating',
    collect: 'service address with suburb and postcode, and confirm it is in the service area; what is going on (split system, ducted air con, evaporative cooler, gas heater or thermostat, age of the unit, what they notice)',
    language: '', languages: [], examples: 'au',
  },
  AE: {
    code: 'AE', name: 'United Arab Emirates', dial: '971', timezone: 'Asia/Dubai', currency: 'AED', locale: 'en-AE',
    timezones: [['Asia/Dubai', 'UAE time']],
    numberRoute: 'sip', workWeek: 'mon-fri',
    trade: 'an air conditioning maintenance company',
    greeting: (b) => `Marhaba! Thanks for calling ${b}, this is the virtual assistant.`,
    // 997 is Civil Defence (fire and gas); 998 ambulance.
    safety: (d) => `Please leave the building right away and call Civil Defence on 997${d?.gasline ? `, or the gas company on ${spoken(d.gasline)}` : ''}, from outside. Call 998 if anyone feels unwell. Your safety comes first.`,
    urgent: 'No cooling in summer heat, especially with elderly people, infants or medical needs, water leaking from the unit, or a burning smell from the AC',
    basicCheck: 'check that the thermostat is set to cool and the breaker hasn\'t tripped.',
    outsideArea: 'suggest they look for a local AC maintenance company',
    defaultServices: 'AC maintenance and repair, duct cleaning, gas top-up, installation, annual maintenance contracts',
    collect: 'service address with area, building and apartment or villa number, and confirm it is in the service area; what is going on (split AC, central or ducted AC, chiller, thermostat, age of the unit, what they notice)',
    language: '', examples: 'gulf',
    // Deepgram supports Gulf Arabic; mixing Arabic and English on one call isn't confirmed, so each shop picks.
    languages: [ENGLISH, { code: 'ar', label: 'Arabic', transcriber: { provider: 'deepgram', model: 'nova-3', language: 'ar-AE' },
      rule: 'LANGUAGE\nMost callers speak Arabic. Speak Arabic unless the caller speaks English. Say times and phone numbers clearly.\n\n' }],
  },
  SA: {
    code: 'SA', name: 'Saudi Arabia', dial: '966', timezone: 'Asia/Riyadh', currency: 'SAR', locale: 'en-SA',
    timezones: [['Asia/Riyadh', 'Saudi time']],
    numberRoute: 'sip', workWeek: 'sun-thu',
    trade: 'an air conditioning maintenance company',
    greeting: (b) => `Marhaba! Thanks for calling ${b}, this is the virtual assistant.`,
    // 911 is the unified emergency number; 998 is Civil Defence (fire and gas); 997 ambulance.
    safety: (d) => `Please leave the building right away and call 911, or Civil Defence on 998${d?.gasline ? `, or the gas company on ${spoken(d.gasline)}` : ''}, from outside. Your safety comes first.`,
    urgent: 'No cooling in summer heat, especially with elderly people, infants or medical needs, water leaking from the unit, or a burning smell from the AC',
    basicCheck: 'check that the thermostat is set to cool and the breaker hasn\'t tripped.',
    outsideArea: 'suggest they look for a local AC maintenance company',
    defaultServices: 'AC maintenance and repair, duct cleaning, gas top-up, installation, annual maintenance contracts',
    collect: 'service address with district, street and building or villa number, and confirm it is in the service area; what is going on (split AC, central or ducted AC, window unit, thermostat, age of the unit, what they notice)',
    language: '', examples: 'gulf',
    languages: [{ code: 'ar', label: 'Arabic', transcriber: { provider: 'deepgram', model: 'nova-3', language: 'ar-SA' },
      rule: 'LANGUAGE\nMost callers speak Arabic. Speak Arabic unless the caller speaks English. Say times and phone numbers clearly.\n\n' }, ENGLISH],
  },
  IN: {
    code: 'IN', name: 'India', dial: '91', timezone: 'Asia/Kolkata', currency: 'INR', locale: 'en-IN',
    timezones: [['Asia/Kolkata', 'India (IST)']],
    numberRoute: 'sip', workWeek: 'mon-sat',
    trade: 'an air conditioning service company',
    greeting: (b) => `Namaste! Thanks for calling ${b}, this is the virtual assistant.`,
    // 112 is India's national emergency number; 1906 is the LPG emergency helpline. A piped-gas
    // company's own number is added when the shop gave one.
    safety: (d) => `Please leave the building right away and call 112${d?.gasline ? `, or the gas company on ${spoken(d.gasline)}` : ', or 1906 for an LPG gas leak'}, from outside. Your safety comes first.`,
    urgent: 'No cooling during a heatwave with elderly people, infants or medical needs, water leaking from the indoor unit, or a burning smell from the AC',
    basicCheck: 'check that the remote is set to cool mode and the MCB hasn\'t tripped.',
    outsideArea: 'suggest they look for a local AC service provider',
    defaultServices: 'AC service and repair, gas refill, installation and uninstallation, annual maintenance contracts (AMC)',
    collect: 'service address with area and PIN code, and confirm it is in the service area; what is going on (split AC, window AC, cassette AC, age of the unit, what they notice)',
    language: 'LANGUAGE\nCallers may speak Hindi, English or a mix of both. Reply in the language the caller uses. Say times, dates and phone numbers clearly, digit by digit for numbers.\n\n',
    examples: 'india',
    // Hindi, English and a mix of both on one call.
    languages: [{ code: 'hi-en', label: 'Hindi and English', transcriber: { provider: 'deepgram', model: 'nova-3', language: 'multi' } }],
  },
};

export const COUNTRY_CODES = Object.keys(COUNTRIES);
export const countryOf = (client) => COUNTRIES[client?.details?.country] || COUNTRIES.US;

// The caller language a shop picked (or the country's first), with its speech-recognition settings.
export function languageOf(client) {
  const c = countryOf(client);
  return c.languages.find((l) => l.code === client?.details?.language) || c.languages[0] || null;
}

function spoken(e164) {
  const ind = /^\+91(\d{5})(\d{5})$/.exec(e164 || '');
  if (ind) return `${ind[1]} ${ind[2]}`;
  const m = /^\+(\d{1,3})(\d+)$/.exec(e164 || '');
  if (!m) return e164;
  const rest = m[2];
  return rest.length > 6 ? `${rest.slice(0, rest.length - 6)} ${rest.slice(-6, -3)} ${rest.slice(-3)}` : rest;
}
