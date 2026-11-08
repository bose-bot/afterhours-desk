// What changes between the countries we serve: the trade, safety numbers, urgent cases, language and examples.
// The US text is the original script, word for word.

export const COUNTRIES = {
  US: {
    code: 'US', name: 'United States', timezone: 'America/New_York', currency: 'USD', locale: 'en-US',
    trade: 'a heating and air conditioning company',
    greeting: (b) => `Thanks for calling ${b}, this is the virtual assistant.`,
    safety: () => 'Please leave the building right away and call 911 or your gas company from outside. Your safety comes first.',
    urgent: 'No heat in freezing weather, no AC in extreme heat with elderly people, infants or medical needs, or water leaking from the unit',
    basicCheck: 'check that the thermostat is set correctly and the breaker hasn\'t tripped.',
    outsideArea: 'suggest they search for a local HVAC provider',
    defaultServices: 'furnace and AC repair, maintenance tune-ups, new system estimates',
    language: '',
  },
  IN: {
    code: 'IN', name: 'India', timezone: 'Asia/Kolkata', currency: 'INR', locale: 'en-IN',
    trade: 'an air conditioning service company',
    greeting: (b) => `Namaste! Thanks for calling ${b}, this is the virtual assistant.`,
    // 112 is India's national emergency number; 1906 is the LPG emergency helpline. A piped-gas
    // company's own number is added when the shop gave one.
    safety: (d) => `Please leave the building right away and call 112${d?.gasline ? `, or the gas company on ${spoken(d.gasline)}` : ', or 1906 for an LPG gas leak'}, from outside. Your safety comes first.`,
    urgent: 'No cooling during a heatwave with elderly people, infants or medical needs, water leaking from the indoor unit, or a burning smell from the AC',
    basicCheck: 'check that the remote is set to cool mode and the MCB hasn\'t tripped.',
    outsideArea: 'suggest they look for a local AC service provider',
    defaultServices: 'AC service and repair, gas refill, installation and uninstallation, annual maintenance contracts (AMC)',
    language: 'LANGUAGE\nCallers may speak Hindi, English or a mix of both. Reply in the language the caller uses. Say times, dates and phone numbers clearly, digit by digit for numbers.\n\n',
  },
};

export const countryOf = (client) => COUNTRIES[client?.details?.country] || COUNTRIES.US;

function spoken(e164) {
  const ind = /^\+91(\d{5})(\d{5})$/.exec(e164 || '');
  return ind ? `${ind[1]} ${ind[2]}` : e164;
}
