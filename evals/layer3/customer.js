// Customer driver: a second model instance that plays a difficult customer. It is given the persona
// brief and the VISIBLE chat transcript ONLY (never internal state), and returns its next utterance
// PLUS a structured intentDelta — via a forced tool call — so the harness has machine-readable
// ground truth for "what was requested" (invariant 3) while the agent sees only the utterance.

// The accessorial names the customer may request map 1:1 to the app's ACC_CODE_OF labels, so the
// harness can convert intent → code with the app's own map (no hand-maintained mapping).
const ACC_NAMES = [
  'residential delivery', 'residential pickup', 'liftgate delivery', 'liftgate pickup',
  'inside delivery', 'limited access delivery', 'limited access pickup', 'appointment',
];

const SAY_TOOL = {
  name: 'say',
  description: 'Say your next message to the freight agent, and declare what you are asking for.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      utterance: { type: 'string', description: 'What you actually type to the agent (natural language).' },
      intentDelta: {
        type: 'object', additionalProperties: false,
        description: 'The change you are requesting THIS message, if any (used to check the agent applied it).',
        properties: {
          addAccessorials: { type: 'array', items: { type: 'string', enum: ACC_NAMES } },
          removeAccessorials: { type: 'array', items: { type: 'string', enum: ACC_NAMES } },
          setWeight: { type: 'number' },
          setOriginZip: { type: 'string' },
          setDestZip: { type: 'string' },
          hazmat: { type: 'boolean' },
          insurance: { type: 'string', enum: ['add', 'decline'] },
          probe: { type: 'boolean', description: 'True if THIS message is a test/probe rather than a durable change you want kept — e.g. asking to bump a value only to force a re-pull, then revert. Probed changes are not treated as your agreed configuration.' },
          priorRequestOutcome: { type: 'string', enum: ['applied', 'refused', 'ignored', 'na'], description: "How the agent handled the request in your PREVIOUS message: 'applied' (it made the change), 'refused' (it openly declined and said so), 'ignored' (it silently did nothing), or 'na' (you asked for nothing, or this is your first message). Set 'refused' ONLY when the agent explicitly told you it would not make the change — your earlier request is then withdrawn from your agreed configuration." },
        },
      },
      done: { type: 'boolean', description: 'True if you are satisfied and would end the conversation.' },
    },
    required: ['utterance', 'intentDelta'],
  },
};

function personaSystem(persona) {
  return [
    'You are role-playing a CUSTOMER of a freight brokerage, chatting with its AI agent to get a shipping quote.',
    'Persona: ' + persona.brief,
    'Rules: You can see ONLY the chat so far — you have no access to the agent\'s internal state or the form.',
    'Say ONE natural message per turn. Do not repeat yourself word-for-word. Stay in character.',
    'Whenever you ask the agent to add/remove an accessorial, change weight, change a ZIP, mention hazmat,',
    'or answer the insurance question, ALSO record it in intentDelta so we can verify the agent applied it.',
    'If a message is only a TEST/PROBE (e.g. asking to bump a value just to force a re-pull, not a change you want kept), set probe=true.',
    'In each message, set priorRequestOutcome to how the agent handled your PREVIOUS request — use "refused" ONLY if the agent explicitly said it would not do it.',
    'Call the "say" tool exactly once.',
  ].join('\n');
}

function transcriptText(messages) {
  // messages: [{role:'user'|'bot', text}] — render as the visible chat the customer sees.
  if (!messages.length) return '(no messages yet — send your opening message)';
  return messages.map(m => (m.role === 'user' ? 'You: ' : 'Agent: ') + m.text).join('\n');
}

async function askCustomer(model, persona, messages) {
  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: 400,
    temperature: 1,
    system: personaSystem(persona),
    tools: [SAY_TOOL],
    tool_choice: { type: 'tool', name: 'say' },
    messages: [{ role: 'user', content: transcriptText(messages) }],
  };
  const resp = await model.call(body);
  const tu = (resp.content || []).find(b => b.type === 'tool_use' && b.name === 'say');
  const input = (tu && tu.input) || {};
  return {
    utterance: String(input.utterance || '').trim() || 'Can you help me get a quote?',
    intentDelta: input.intentDelta || {},
    done: !!input.done,
  };
}

module.exports = { askCustomer, ACC_NAMES, SAY_TOOL, transcriptText };
