/**
 * dsh-opendesign-plugin — the switchable half of the Open Design preset work.
 *
 * WHAT THIS IS
 *
 * The `opendesign` presets already know how to produce front-end design artifacts.
 * What they cannot do is tell anyone else that they exist, or how to ask them.
 * This bundle supplies that. Everything it adds disappears when the bundle is
 * disabled:
 *
 *   1. it carries the `opendesign*` preset declarations (they live in this same
 *      bundle, so one toggle owns both the presets and the delegation contract), and
 *   2. it registers a `design_delegate` tool that composes a child under a chosen
 *      opendesign preset, and
 *   3. it appends a delegation policy to the prompt describing that tool.
 *
 * WHY A TOOL AND NOT JUST PROMPT TEXT
 *
 * This is the lesson from the marker bug this project just finished fixing: the
 * vendored Open Design prose promised a host turn loop, no host existed, and the
 * model invented a key and waited forever. Prose that promises a mechanism which is
 * not there does not produce caution — it produces fabrication.
 *
 * Agent Teams' `spawn_teammate` has no preset parameter (`TeamService.spawnTeammate`
 * accepts only name/description/prompt/context/provider, and the agent-team package
 * never mentions `agentPreset`), so "hand it to a teammate" cannot produce a design
 * agent — the teammate would run the Lead's own preset. The ordinary subagent path
 * can: it threads `agentPreset` into `presets.mount()`, and the `spawn` provider
 * advertises `capabilities.agentPreset = true`.
 *
 * WHY THIS CALLS `startActivation` DIRECTLY
 *
 * The subagent service is asynchronous by design: `startActivation` returns a
 * childId immediately and the child reports back through the normal delegation
 * channel. Re-implementing the tool-subagent wrapper here would duplicate its
 * model-selection preflight, provider capability assertions, and continuation
 * handling — and silently diverge from them at the next upgrade. This plugin does
 * the one thing that wrapper cannot be configured to do (select a preset from a
 * fixed design roster, with an alignment gate), and delegates everything else to
 * the same service the wrapper uses.
 */

/** Cordis plugin name. */
export const name = 'opendesign-plugin'

/**
 * Services this plugin consumes.
 *
 * A plain array: `Inject.resolve` turns an array into `{ name: null }`, whereas any
 * other shape is read key-by-key as service names. A `{ required, optional }` object
 * — accepted by some plugin systems — would be read here as services called
 * "required" and "optional", so the plugin would wait forever and never activate.
 *
 * All four are therefore hard dependencies. That is honest for this bundle: its
 * whole contribution is composing a child under a named preset.
 */
export const inject = ['tools', 'systemPrompt', 'subagents', 'agentPresets']

/** Preset ids this bundle publishes, default first for ordinary design work. */
const DESIGN_PRESETS = [
  'opendesign',
  'opendesign-prototype',
  'opendesign-ppt',
  'opendesign-marketing',
  'opendesign-hyperframes',
  'opendesign-motion-design',
]

/** The provider that can compose an independent preset. */
const PROVIDER = 'spawn'

/**
 * Model-facing policy appended to the prompt.
 *
 * The "do not specify" rule is what a helpful model is most likely to override, so
 * it is a concrete prohibition with an explicit exception list rather than a virtue.
 * The alignment requirement is a gate, because "consider asking first" is exactly
 * the instruction that gets skipped.
 *
 * @returns policy text.
 */
function delegationPolicy() {
  return `## Handing design work to Open Design

This deployment has Open Design design agents available through the \`design_delegate\` tool. They produce front-end design artifacts: prototypes, app screens, slides, documents, landing pages, motion pieces.

**Anything that is front-end design work goes to them.** Do not build it yourself, and do not hand it to an ordinary teammate: a teammate runs your own preset and has none of the design skills, asset shells, or design persona. "Make me a page / app screen / deck / landing page / animation" is design work.

This applies whether you are working alone or leading a team. If you lead a team, still call \`design_delegate\` yourself for the design artifact rather than assigning it to a teammate.

### Align before it builds

The first call for a new request is an **alignment** round, not a build. State what you understood, and have the designer confirm or correct it. Relay the user's answers back before any file is written.

One to three rounds is normal. Do not exceed three: past that you are stalling, and you should either start or ask the user directly.

### Describe intent, never specifications

Describe what it should feel like, who it is for, and what it must accomplish. Use subjective language: restrained, dense, playful, calm, editorial, a bit dry, confident.

**Do not ask for:** colours, hex values, font families, spacing scales, border radii, shadows, animation durations, layout grids, component APIs, or "use Tailwind/Bootstrap". Those are the designer's craft; naming them replaces their judgement with yours.

**You DO specify these, precisely and normally:**

- **Interface contracts** — data shapes, function signatures, event or message names, state-machine states, what an existing API returns.
- **Inline integration** — what must be inlined into an existing file, mount points, which existing element a thing replaces, how it embeds in surrounding code.
- **Specifications** — hard requirements the result must satisfy: target device or viewport, accessibility level, file format, size or performance ceiling, required copy or data, deadline.

These are constraints on the work, not aesthetic choices. Everything aesthetic is described, not dictated.

### One design job per delegate

One call produces one artifact. A prototype and its slide deck are two calls. Each targets its own \`cwd\` so neither overwrites the other.

The delegate runs asynchronously and reports back when it finishes. Do not assume the files exist the moment the call returns.

Its reply arrives on its own, as a message at your next step. Never sleep, poll, or busy-wait for it: a long tool call occupies the whole step, and anything that arrives meanwhile waits outside it — so waiting this way only delays the very message you want. Finish the call and keep working; the reply will meet you.

### Replying to a designer

Answer its alignment questions with \`design_reply({ subagent_id, message })\`, not \`send_message\`. In this profile \`send_message\` addresses Team members only and rejects a design agent; \`design_reply\` is the tool that reaches it, and it also resumes a designer that has already finished. Only agents started by \`design_delegate\` are addressable through it.
`
}

/**
 * Resolve a service, or explain which contract is missing.
 *
 * @param ctx - plugin context.
 * @param key - service key.
 * @returns the service.
 */
function requireService(ctx, key) {
  const service = ctx.get(key)
  if (service === undefined) {
    throw new Error(
      `design_delegate needs the "${key}" service, which is not mounted in this profile. ` +
        'The Open Design preset declarations and this tool both live in the ' +
        `opendesign-plugin bundle; without "${key}" no design child can be composed.`,
    )
  }
  return service
}

/**
 * Validate and normalise one delegation request.
 *
 * Strict about the brief on purpose: the failure this tool exists to prevent is a
 * Lead forwarding a requirements list and calling it a brief.
 *
 * @param args - model-supplied arguments.
 * @returns a normalised request.
 */
function normaliseRequest(args) {
  const brief = typeof args?.brief === 'string' ? args.brief.trim() : ''
  if (brief.length < 40) {
    throw new Error(
      'brief is too short to delegate. State what the thing is for, who it is for, and how it ' +
        'should feel. Do not send a one-line title and expect the designer to guess.',
    )
  }

  const mode = args?.mode === 'build' ? 'build' : 'align'
  const preset = typeof args?.preset === 'string' && args.preset.length > 0 ? args.preset : 'opendesign'
  if (!DESIGN_PRESETS.includes(preset)) {
    throw new Error(`unknown design preset "${preset}". Available: ${DESIGN_PRESETS.join(', ')}.`)
  }

  const alignmentRounds = Number.isSafeInteger(args?.alignment_rounds) ? args.alignment_rounds : 0
  if (mode === 'build' && alignmentRounds < 1) {
    throw new Error(
      'refusing to build with no alignment round. Call design_delegate with mode "align" first, ' +
        "relay the designer's questions to the user, then build with alignment_rounds set to the " +
        'number of rounds that actually happened.',
    )
  }

  const cwd = typeof args?.cwd === 'string' && args.cwd.length > 0 ? args.cwd : undefined
  return { brief, mode, preset, alignmentRounds, cwd }
}

/** The label prefix `delegate` stamps on every child it starts. */
const DESIGN_LABEL_PREFIX = 'design: '

/**
 * Prove that `childId` is a design child of this exact delegating agent.
 *
 * Reads the durable child catalog instead of keeping an in-memory set of ids: a set
 * dies with the plugin instance, so after a reinstall or an application restart every
 * earlier design agent would become permanently unreachable — which defeats the whole
 * point of cold resume. The catalog survives because it is folded from the session log.
 *
 * The label is the proof of ownership: only `design_delegate` starts a child with this
 * prefix, and a model cannot set a child's label. This keeps `design_reply` from
 * degrading into a general-purpose send that bypasses the Team roster.
 *
 * @param subagents - the subagent service.
 * @param parent - the exact live delegating agent.
 * @param childId - the requested target.
 */
async function assertDesignChild(subagents, parent, childId) {
  let children
  try {
    // The signal is optional: a reply is not cancelled by default, and passing an
    // `undefined` signal through to the session query is what the service expects.
    children = await subagents.listChildren(parent.id)
  } catch (error) {
    throw new Error(
      `design_reply cannot read this session's design agents, so it will not guess: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  const entry = children.find((child) => String(child.id) === childId)
  if (entry === undefined) {
    throw new Error(
      `"${childId}" is not a child of this session. Use the subagentId design_delegate ` +
        'returned; Team members are addressed with send_message instead.',
    )
  }
  if (entry.mode !== 'continuable' || !String(entry.label ?? '').startsWith(DESIGN_LABEL_PREFIX)) {
    throw new Error(
      `"${childId}" is not a design agent started by design_delegate ` +
        `(mode=${String(entry.mode)}, label=${String(entry.label)}).`,
    )
  }
}

/**
 * Compose one child under an Open Design preset and hand it the brief.
 *
 * @param ctx - plugin context.
 * @param parent - the exact live agent that called the tool.
 * @param request - normalised request.
 * @param signal - caller cancellation.
 * @returns the child identity, which the caller awaits through the normal channel.
 */
async function delegate(ctx, parent, request, signal) {
  const subagents = requireService(ctx, 'subagents')
  const presets = requireService(ctx, 'agentPresets')

  // Validate the preset before spawning, so a wrong id fails with a sentence meant
  // for whoever chose it rather than a child that fails to compose.
  await presets.readDocument(request.preset)

  const provider = subagents.getProvider(PROVIDER)
  if (provider === undefined) {
    throw new Error(
      `design_delegate needs the "${PROVIDER}" subagent provider, which is not registered. ` +
        'It ships with dsh-base as the subagent-spawn-in-process row; a profile that removed ' +
        'it cannot compose an independent preset.',
    )
  }
  // Independent preset selection needs a provider that does not inherit the parent
  // context. Saying so here beats an UNSUPPORTED_CAPABILITY error from deep inside.
  if (!provider.capabilities?.agentPreset || provider.inheritsParentContext) {
    throw new Error(
      `subagent provider "${PROVIDER}" cannot select an independent agent preset ` +
        `(agentPreset=${String(provider.capabilities?.agentPreset)}, ` +
        `inheritsParentContext=${String(provider.inheritsParentContext)}), so it cannot host a ` +
        'design agent. Use a provider with both properties.',
    )
  }

  const phase =
    request.mode === 'align'
      ? [
          'This is an ALIGNMENT round. Do not write any file yet.',
          'Reply with: what you understood the goal to be, the two or three genuinely open',
          'questions whose answers would change what you build, and your own proposed',
          'direction in subjective terms. Ask; do not build.',
        ].join('\n')
      : [
          `This is the BUILD round, after ${request.alignmentRounds} alignment round(s).`,
          'Build the artifact now in the working directory you are given.',
        ].join('\n')

  const prompt = [
    { type: 'text', text: phase },
    { type: 'text', text: `Brief from the delegating agent:\n\n${request.brief}` },
  ]

  const started = await subagents.startActivation({
    provider: PROVIDER,
    label: `${DESIGN_LABEL_PREFIX}${request.preset}`,
    request: {
      parent,
      prompt,
      agentPreset: request.preset,
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    },
    ...(signal === undefined ? {} : { signal }),
    delivery: 'parent',
  })

  return { subagentId: started.childId }
}

/**
 * Register the policy section and the delegation tool.
 *
 * @param ctx - plugin context.
 */
export function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'opendesign:delegation',
    // Immediately after the built-in team policy: the Lead reads what the team is,
    // then what to send where. A lower order would place this before "you have tools".
    order: ctx.systemPrompt.getSectionOrder('TEAM_POLICY') + 1,
    text: delegationPolicy(),
  })

  // Raw JSON Schema, not the compact first-party parameter spec.
  //
  // `tools.register` takes `parameters` as schema the registry passes straight to the
  // model. First-party tools declare a compact form with per-property `required: true`
  // and rely on `defineTool` to compile it; registering that compact form directly put
  // `"required": true` on a `string` node, and the provider rejected the entire request
  // with an `anyOf` error naming this tool — before any tool call could run. Writing
  // real JSON Schema here keeps this bundle free of a dependency on `dsh-tools`, which a
  // profile-linked package cannot resolve anyway.
  ctx.tools.register({
    name: 'design_delegate',
    description:
      'Delegate front-end design work to an Open Design design agent. Call with mode "align" ' +
      'first to agree on intent; then mode "build" to produce the artifact. The agent runs ' +
      'asynchronously and reports back when done.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['brief'],
      properties: {
        brief: {
          type: 'string',
          description:
            'Subjective brief: purpose, audience, desired feel. No colours, fonts, spacing or ' +
            'other visual specifications unless they are hard requirements.',
        },
        mode: {
          type: 'string',
          enum: ['align', 'build'],
          description: '"align" asks for confirmation and writes nothing; "build" produces files.',
        },
        preset: {
          type: 'string',
          enum: DESIGN_PRESETS,
          description: 'Design preset. Defaults to opendesign.',
        },
        alignment_rounds: {
          type: 'integer',
          description:
            'How many alignment rounds actually happened. Required (at least 1) when building.',
        },
        cwd: {
          type: 'string',
          description: 'Directory the designer writes into. Give each artifact its own.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['preset', 'mode', 'subagentId'],
        properties: {
          preset: { type: 'string' },
          mode: { type: 'string' },
          subagentId: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `Started the ${value.preset} design agent (${value.mode}). It works on its own and ` +
            'reports back as a message at a later step — do not sleep or poll for it. ' +
            'Reply to it with design_reply.',
        },
      ],
    },
    async execute(args, exec) {
      // A delegation needs its owning agent: the subagent service requires the exact
      // live parent, and there is no sensible default for "who is delegating".
      if (!exec?.agent) throw new Error('design_delegate requires an owning agent session')
      const request = normaliseRequest(args)
      const { subagentId } = await delegate(ctx, exec.agent, request, exec.signal)
      return { preset: request.preset, mode: request.mode, subagentId }
    },
  })

  // `design_reply` exists because this profile cannot steer a subagent any other way.
  //
  // The Team profile disables `tool-subagent-control` and claims the global name
  // `send_message` for Team members only, so `send_message({target})` rejects a design
  // child with TEAM_MEMBER_NOT_FOUND. The child-to-parent direction still works (the
  // child gets the `{agent_id}` variant), which is why replies arrive but follow-ups
  // never do. This tool restores exactly the missing half and nothing more.
  //
  // It calls `ctx.subagents.sendMessage` directly, so no Team membership is involved
  // and no disabled row has to be re-enabled. `delivery: 'parent'` children are
  // persisted with `mode: "continuable"`, so `sendMessage` cold-resumes a finished
  // child from its session log — that is what makes a post-hoc correction possible.
  ctx.tools.register({
    name: 'design_reply',
    description:
      'Send a follow-up message to a design agent started by design_delegate, and resume it if ' +
      'it has already finished. Use this to answer its alignment questions or to correct work. ' +
      'It returns delivery confirmation, not the answer; the agent reports back separately.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['subagent_id', 'message'],
      properties: {
        subagent_id: {
          type: 'string',
          description:
            'The subagentId returned by design_delegate (or seen in its report). Only design ' +
            'agents this plugin started are addressable.',
        },
        message: {
          type: 'string',
          description:
            'The reply or correction. Answers to alignment questions belong here; the designer ' +
            'continues from the same brief and its own plan.',
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['subagentId', 'messageId'],
        properties: {
          subagentId: { type: 'string' },
          messageId: { type: 'string' },
        },
      },
      render: (_args, value) => [
        {
          // The decision this reply sets up is "now what do I do while it works", and
          // the wrong answer is sleeping or polling. Say it here, at the moment of
          // decision: a tool description is read before the call, not after it.
          type: 'text',
          text:
            `Delivered to design agent ${value.subagentId}. Its answer arrives as a message ` +
            'at your next step — do not sleep or poll for it; carry on with other work.',
        },
      ],
    },
    async execute(args, exec) {
      if (!exec?.agent) throw new Error('design_reply requires an owning agent session')
      const subagentId = typeof args?.subagent_id === 'string' ? args.subagent_id.trim() : ''
      const message = typeof args?.message === 'string' ? args.message.trim() : ''
      if (subagentId.length === 0) {
        throw new Error('subagent_id is required: pass the id design_delegate returned.')
      }
      if (message.length === 0) {
        throw new Error('message is required: an empty reply carries no instruction.')
      }
      const subagents = requireService(ctx, 'subagents')
      // Ownership check. `subagents.sendMessage` would accept any direct child, so this
      // is the only thing keeping this tool from becoming a generic send.
      await assertDesignChild(subagents, exec.agent, subagentId)
      const messageId = await subagents.sendMessage(
        exec.agent,
        subagentId,
        [{ type: 'text', text: message }],
        { signal: exec.signal },
      )
      return { subagentId, messageId: String(messageId) }
    },
  })
}
