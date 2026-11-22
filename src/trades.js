// Every kind of business the receptionist answers for, as data: what the business is, what counts as
// dangerous or urgent, what a caller may safely check, the usual services, what to ask, and example calls.
// The country (src/countries.js) supplies emergency numbers, address formats, phone formats and language.
// HVAC keeps the original script word for word: its wording comes from the country entries.
// Adding a trade = adding an entry here.

// The general emergency number to say out loud, per country.
const EMERGENCY = { US: '911', CA: '911', GB: '999', AU: '000', AE: '999, or 998 for an ambulance', SA: '911', IN: '112' };
export const emergencyLine = (C) => EMERGENCY[C.code] || '911';

// The address part of a country's booking checklist ("service address with city or ZIP, and confirm…").
export const addressAsk = (C) => String(C.collect || '').split('; what is going on')[0] || 'service address, and confirm it is in the service area';

const visit = {
  bookWhat: 'a visit', bookLine: "Sorry to hear that. Let's get someone out to you.",
  onWay: "The team will call when they're on the way.",
};

export const TRADES = {
  hvac: {
    code: 'hvac', label: 'Heating & air conditioning (HVAC)', fromCountry: true, staff: 'technician', ...visit,
  },
  plumbing: {
    code: 'plumbing', label: 'Plumbing', trade: 'a plumbing company', noun: 'plumber', staff: 'plumber', ...visit,
    bookLine: "Sorry about that. Let's get a plumber out.", onWay: "The plumber will call when they're on the way.",
    dangers: 'a gas smell, water near electrical outlets or the electrical panel, sewage coming up inside the home, or anyone hurt',
    safety: (C, d) => `${C.safety(d)} If water is near anything electrical, stay well away from it.`,
    urgent: "A burst pipe or water that won't stop, no water at all, a sewer backup, no hot water with elderly people, infants or medical needs, or the only toilet blocked",
    basicCheck: "turn off the water at the main shut-off valve if something is leaking.",
    defaultServices: 'leak and burst pipe repair, drain cleaning, water heaters, toilets and fixtures, sewer lines',
    details: 'what is going on (leak, clog, water heater, toilet or sewer; where in the home, for how long, any water damage)',
    ex: { problem: "Water's pouring out from under my kitchen sink.", danger: "There's water all over the basement floor, right up to the electrical panel.", price: 'How much to replace a water heater?', what: "what's needed and the parts", look: 'take a look' },
  },
  electrical: {
    code: 'electrical', label: 'Electrical', trade: 'an electrical contractor', noun: 'electrician', staff: 'electrician', ...visit,
    bookLine: "Sorry about that. Let's get an electrician out.", onWay: "The electrician will call when they're on the way.",
    dangers: 'sparking, a burning smell, smoke, a hot or buzzing outlet or panel, a power line down, or anyone who got a shock',
    safety: (C) => `Please don't touch anything electrical. If there's smoke, sparks or a burning smell, leave the building and call ${emergencyLine(C)} from outside, and stay well away from any fallen power lines. Your safety comes first.`,
    urgent: 'No power to the whole building, power out with medical equipment at home, a breaker that keeps tripping, or water leaking near wiring',
    basicCheck: 'check whether a breaker has tripped in the panel, and whether the neighbours have power.',
    defaultServices: 'troubleshooting and repairs, panel upgrades, outlets and lighting, EV chargers, generators',
    details: 'what is going on (no power, tripping breaker, outlets, lighting or a new installation; where in the building, for how long)',
    ex: { problem: 'Half the outlets in my house just stopped working.', danger: 'One of my outlets is sparking and I can smell burning.', price: 'How much for a new panel?', what: "the wiring and what's needed", look: 'take a look' },
  },
  roofing: {
    code: 'roofing', label: 'Roofing', trade: 'a roofing company', noun: 'roofer', staff: 'roofer', ...visit,
    bookLine: "Sorry about that. Let's get someone out to look at the roof.", onWay: "The roofer will call when they're on the way.",
    dangers: 'a ceiling sagging or coming down, water coming through a light fitting, a tree on the roof, or anyone hurt',
    safety: (C) => `Please keep everyone out of that room and away from any wet lights or switches. If the ceiling is coming down or anyone is hurt, call ${emergencyLine(C)}. Your safety comes first.`,
    urgent: 'An active leak into the home, storm damage that has left the roof open, or missing shingles or tiles with rain on the way',
    basicCheck: 'put a bucket under the drip and move valuables away from the water.',
    defaultServices: 'leak repair, storm damage, roof replacement, gutters, inspections',
    details: 'what is going on (leak, storm damage, missing shingles or tiles, gutters or a replacement quote; roughly how old the roof is)',
    ex: { problem: "Water's dripping through my bedroom ceiling since the storm.", danger: "The living room ceiling is bulging and dripping right by the light.", price: 'How much for a new roof?', what: 'the size of the roof and the materials', look: 'inspect it' },
  },
  pest: {
    code: 'pest', label: 'Pest control', trade: 'a pest control company', noun: 'pest control company', staff: 'technician', ...visit,
    bookLine: "I can help with that. Let's get a technician out.", onWay: "The technician will call when they're on the way.",
    dangers: 'a swarm of bees or wasps near people, someone stung or bitten who is swelling up or having trouble breathing, or a snake inside',
    safety: (C) => `Please move everyone away from that area and keep the door closed. If anyone is having trouble breathing or feels unwell after a sting or bite, call ${emergencyLine(C)} now. Your safety comes first.`,
    urgent: 'Wasps, hornets or bees by a doorway, rodents in the kitchen, bed bugs, or pests in a business that has to stay open',
    basicCheck: 'keep children and pets away from the area.',
    defaultServices: 'ants, roaches, rodents, termites, bed bugs, wasps and bees, regular treatments',
    details: 'what pest they are seeing, where, for how long, and whether there are children or pets at home',
    ex: { problem: 'We have mice in the kitchen. I saw two this morning.', danger: "There's a wasp nest by the front door and my son just got stung. His face is swelling.", price: 'How much is a termite treatment?', what: 'the size of the home and the problem', look: 'inspect' },
  },
  appliance: {
    code: 'appliance', label: 'Appliance repair', trade: 'an appliance repair company', noun: 'appliance repair company', staff: 'technician', ...visit,
    bookLine: "Sorry about that. Let's get a technician out.", onWay: "The technician will call when they're on the way.",
    dangers: 'a gas smell from a stove, oven or dryer, smoke or a burning smell, sparking, or water near an outlet',
    safety: (C, d) => C.safety(d),
    urgent: 'A fridge or freezer not cooling with food inside, a washer or dishwasher leaking, or an oven out before a big event',
    basicCheck: "check the appliance is plugged in and the breaker hasn't tripped.",
    defaultServices: 'refrigerator, freezer, washer, dryer, dishwasher, oven and stove repair',
    details: 'which appliance, the brand and roughly how old it is, and what it is doing',
    ex: { problem: 'My fridge stopped cooling and everything is getting warm.', danger: "My dryer's making a burning smell.", price: 'How much to fix a dishwasher?', what: 'the model and the part', look: 'take a look' },
  },
  garage: {
    code: 'garage', label: 'Garage doors', trade: 'a garage door company', noun: 'garage door company', staff: 'technician', ...visit,
    bookLine: "Sorry about that. Let's get a technician out.", onWay: "The technician will call when they're on the way.",
    dangers: 'someone trapped or hurt by the door, a door that has fallen, or a snapped spring or cable hanging loose',
    safety: (C) => `Please keep everyone, especially children and pets, away from the door, and don't try to lift it or touch the springs or cables. If anyone is hurt, call ${emergencyLine(C)}. Your safety comes first.`,
    urgent: "A door stuck open so the home can't be locked, or a car trapped inside that is needed for work or a medical trip",
    basicCheck: 'check the opener is plugged in and nothing is blocking the safety sensors.',
    defaultServices: 'broken springs and cables, opener repair, new doors, tune-ups',
    details: "what the door is doing (won't open, won't close, noisy or off track), and whether a car is stuck inside",
    ex: { problem: "My garage door won't open and my car's stuck inside.", danger: 'The spring snapped and the door is hanging crooked.', price: 'How much for a new garage door?', what: 'the size and style of the door', look: 'take a look' },
  },
  locksmith: {
    code: 'locksmith', label: 'Locksmith', trade: 'a locksmith', noun: 'locksmith', staff: 'locksmith', ...visit,
    bookLine: "I can help with that. Let's get a locksmith to you.", onWay: "The locksmith will call when they're on the way.",
    dangers: 'a child or pet locked in a car or room, a break-in happening now, or anyone in danger',
    safety: (C) => `If a child or pet is locked in a car or anyone is in danger, please call ${emergencyLine(C)} right away. If someone may still be inside after a break-in, stay outside and call ${emergencyLine(C)}. Your safety comes first.`,
    urgent: "Locked out of a home or car, a lock broken after a break-in, or a business that can't be secured",
    basicCheck: 'check every door and window in case one is open.',
    defaultServices: 'lockouts, rekeying, lock changes, car keys, safes',
    details: 'what is locked or broken (home, car or business), and whether anyone is waiting outside',
    ex: { problem: "I'm locked out of my house and my keys are inside.", danger: "My toddler is locked in the car and it's hot out.", price: 'How much to rekey all my locks?', what: 'how many locks and what type', look: 'take a look' },
  },
  cleaning: {
    code: 'cleaning', label: 'Cleaning', trade: 'a cleaning company', noun: 'cleaning company', staff: 'team member', ...visit,
    bookLine: 'I can help with that.', onWay: 'The team will call before they arrive.',
    dangers: 'a gas smell, smoke, water near anything electrical, or anyone hurt or unwell',
    safety: (C) => `Please stay away from any water near electrics, and if you smell gas or anyone is in danger, leave the building and call ${emergencyLine(C)}. Your safety comes first.`,
    urgent: 'Flooding or water damage that needs drying fast, a move-out or move-in today, or a mess that is a health risk',
    basicCheck: 'move valuables away from any water.',
    defaultServices: 'home and office cleaning, deep cleans, move-in and move-out cleans, carpet cleaning',
    details: 'what needs cleaning, the size of the space, any pets, and the date they need it by',
    ex: { problem: "We're moving out on Friday and need a deep clean.", danger: 'Our basement flooded and the water is up to the outlets.', price: 'How much for a three-bedroom deep clean?', what: 'the size of the home and the work', look: 'see the space' },
  },
  landscaping: {
    code: 'landscaping', label: 'Landscaping & tree care', trade: 'a landscaping and tree care company', noun: 'landscaper', staff: 'crew member', ...visit,
    bookLine: 'I can help with that. Let me get someone out to you.', onWay: "The crew will call when they're on the way.",
    dangers: 'a fallen tree on a house, car or power line, or anyone hurt',
    safety: (C) => `Please stay well away from the tree and any power lines. If a power line is down or anyone is hurt, call ${emergencyLine(C)}. Your safety comes first.`,
    urgent: 'A fallen tree or large branch blocking a driveway or road, or a broken sprinkler flooding the yard',
    basicCheck: 'turn the sprinkler system off at the controller.',
    defaultServices: 'lawn care, tree trimming and removal, sprinklers and irrigation, landscaping',
    details: 'what they need done, roughly how big the yard is, and any deadline',
    ex: { problem: "A big branch came down in the storm and it's blocking my driveway.", danger: 'A tree fell onto the power line in my front yard.', price: 'How much to take down a tree?', what: 'the size of the tree and the access', look: 'take a look' },
  },
  other: {
    code: 'other', label: 'Other business', trade: null, noun: 'business', staff: 'team member',
    bookWhat: 'an appointment', bookLine: 'I can help with that.', onWay: 'The team will see you then.',
    dangers: 'anyone hurt, in danger, or having a medical emergency',
    safety: (C) => `If anyone is in danger or needs urgent medical help, please hang up and call ${emergencyLine(C)} now. Your safety comes first.`,
    urgent: "Anything the caller says can't wait until the next working day",
    basicCheck: '',
    defaultServices: 'see the services the owner listed',
    details: 'what they need, and their address only if the team comes to them',
    noAddress: true,
    ex: { problem: "Hi, I'd like to book an appointment for next week.", danger: "Someone here just collapsed and isn't breathing properly.", price: 'How much does it cost?', what: 'what you need', look: 'go over it with you' },
  },
};
export const TRADE_CODES = Object.keys(TRADES);

const an = (s) => (/^[aeiou]/i.test(s) ? `an ${s}` : `a ${s}`);

/** The shop's trade, with the parts that depend on its country and details filled in. */
export function tradeOf(client, C) {
  const T = TRADES[client?.details?.trade] || TRADES.hvac;
  if (T.fromCountry) return { ...T, trade: C.trade, urgent: C.urgent, basicCheck: C.basicCheck, outsideArea: C.outsideArea, defaultServices: C.defaultServices, collect: C.collect };
  const type = String(client?.details?.businessType || '').trim().replace(/^(a|an|the)\s+/i, '');
  return {
    ...T,
    trade: T.trade || (type ? an(type) : 'a local business'),
    outsideArea: `suggest they search for a local ${T.code === 'other' ? (type || 'business') : T.noun}`,
    collect: T.noAddress ? T.details : `${addressAsk(C)}; ${T.details}`,
  };
}
