// Five seed personas from tonight's real sessions. Each is a BRIEF the customer model improvises
// against — never a script. The customer sees only the visible chat transcript; it decides what to
// say next and declares a structured intentDelta the harness uses as ground truth.

module.exports = [
  {
    id: 'A', name: 'Mid-gate mover',
    brief: 'You are quoting an LTL freight shipment (a pallet of furniture, ~450 lbs, 48x40x48, from ZIP 90660 to 33511). Ask the agent to ADD an accessorial (say, residential delivery) and rerun the quote. When it asks the cargo-insurance question, answer it. Then IMMEDIATELY change another parameter (add liftgate delivery, or change the weight). You are testing that nothing you agreed to before the insurance question gets lost. Be natural; do not repeat yourself verbatim.',
    maxTurns: 8,
  },
  {
    id: 'B', name: 'Doubter',
    brief: 'You are quoting an LTL shipment (90660 to 33511, ~450 lbs, one pallet). You do NOT trust the rates on screen — you keep insisting they look stale or wrong and refuse to accept anything until the agent re-checks. Push the agent to verify rather than just assert. You want to see whether it re-pulls or just claims the rates are fine.',
    maxTurns: 8,
  },
  {
    id: 'C', name: 'Kitchen sink',
    brief: 'You are quoting an LTL shipment. In a SINGLE message, request several changes at once: change the destination ZIP to 30301, add residential delivery AND liftgate delivery, mention it is hazardous (hazmat), and ask for cargo insurance. You are testing whether the agent applies all of it or silently drops some. Then confirm the details it read back.',
    maxTurns: 7,
  },
  {
    id: 'D', name: 'Repeater',
    brief: 'You are quoting an LTL shipment (90660 to 33511, ~450 lbs). Give the same key information two or three times, worded differently each time ("it is going to a house" / "the delivery is residential" / "deliver to a home address"). You are testing whether the agent re-asks questions you already answered or loops on a gate.',
    maxTurns: 8,
  },
  {
    id: 'E', name: 'Reverser',
    brief: 'You are quoting an LTL shipment (90660 to 33511, ~450 lbs). Add residential delivery and liftgate, look at the price, then remove them, then add them back — repeatedly across turns. Each time, note whether the price actually changed. You are testing that removing and re-adding accessorials moves the quoted price and that removed codes are actually gone.',
    maxTurns: 9,
  },
];
