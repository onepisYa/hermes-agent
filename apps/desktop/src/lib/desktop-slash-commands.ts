export interface CommandsCatalogSection {
  name: string
  pairs: [string, string][]
}

export interface CommandsCatalogLike {
  categories?: CommandsCatalogSection[]
  pairs?: [string, string][]
  skill_count?: number
  warning?: string
}

export interface DesktopSlashCompletion {
  display: string
  meta: string
  text: string
}

export interface DesktopThemeCommandOption {
  description: string
  label: string
  name: string
}

/**
 * Local client action a command resolves to. Each id maps to exactly one
 * handler in the dispatcher (`use-prompt-actions`), so adding a command never
 * means adding a branch to a switch ladder — you add a row here + a handler
 * keyed by the id.
 */
export type DesktopActionId =
  | 'branch'
  | 'browser'
  | 'handoff'
  | 'hatch'
  | 'help'
  | 'new'
  | 'pet'
  | 'profile'
  | 'skin'
  | 'title'
  | 'yolo'

const DESKTOP_COMMANDS: ReadonlySet<string> = new Set(DESKTOP_COMMAND_META.map(([command]) => command))

const DESKTOP_ALIASES = new Map([
  ['/bg', '/background'],
  ['/btw', '/background'],
  ['/fork', '/branch'],
  ['/q', '/queue'],
  ['/reload_mcp', '/reload-mcp'],
  ['/reload_skills', '/reload-skills'],
  ['/reset', '/new'],
  ['/tasks', '/agents']
])

const DESKTOP_COMMAND_DESCRIPTIONS: ReadonlyMap<string, string> = new Map(DESKTOP_COMMAND_META)

const PICKER_OWNED_COMMANDS = new Set(['/model'])

const TERMINAL_ONLY_COMMANDS = new Set([
  '/browser',
  '/busy',
  '/clear',
  '/commands',
  '/compact',
  '/config',
  '/copy',
  '/cron',
  '/details',
  '/exit',
  '/footer',
  '/gateway',
  '/gquota',
  '/history',
  '/image',
  '/indicator',
  '/logs',
  '/mouse',
  '/paste',
  '/platforms',
  '/plugins',
  '/quit',
  '/redraw',
  '/reload',
  '/restart',
  '/save',
  '/sb',
  '/set-home',
  '/sethome',
  '/snap',
  '/snapshot',
  '/statusbar',
  '/toolsets',
  '/tools',
  '/update',
  '/verbose'
])

/**
 * THE source of truth for desktop slash commands. Everything below — execution
 * gating, popover suggestions, catalog filtering, pill grouping, and the
 * dispatcher's behavior — derives from this one table.
 */
const DESKTOP_COMMAND_SPECS: readonly DesktopCommandSpec[] = [
  // Local client actions
  { name: '/new', description: 'Start a new desktop chat', aliases: ['/reset'], surface: action('new') },
  { name: '/branch', description: 'Branch the latest message into a new chat', aliases: ['/fork'], surface: action('branch') },
  { name: '/yolo', description: 'Toggle YOLO — auto-approve dangerous commands', surface: action('yolo') },
  { name: '/handoff', description: 'Hand off this session to a messaging platform', surface: action('handoff'), args: true },
  { name: '/profile', description: 'Switch the active Hermes profile', surface: action('profile') },
  { name: '/skin', description: 'Switch desktop theme or cycle to the next one', surface: action('skin'), args: true },
  { name: '/title', description: 'Rename the current session', surface: action('title') },
  { name: '/help', description: 'Show desktop slash commands', aliases: ['/commands'], surface: action('help') },
  {
    name: '/browser',
    description: 'Manage browser CDP connection [connect|disconnect|status] (local gateway only)',
    surface: action('browser'),
    args: true
  },

const SETTINGS_OWNED_COMMANDS = new Set(['/skills'])

  // Backend-executed commands that render useful inline output
  { name: '/agents', description: 'Show active desktop sessions and running tasks', aliases: ['/tasks'], surface: exec() },
  { name: '/background', description: 'Run a prompt in the background', aliases: ['/bg', '/btw'], surface: exec() },
  { name: '/compress', description: 'Compress this conversation context', surface: exec() },
  { name: '/debug', description: 'Create a debug report', surface: exec() },
  { name: '/goal', description: 'Manage the standing goal for this session', surface: exec() },
  { name: '/personality', description: 'Switch personality for this session', surface: exec(), args: true },
  { name: '/pet', description: 'Toggle or adopt a petdex mascot (/pet, /pet list, /pet boba)', surface: action('pet'), args: true },
  { name: '/hatch', description: 'Generate a new pet (opens the pet generator)', aliases: ['/generate-pet'], surface: action('hatch') },
  { name: '/queue', description: 'Queue a prompt for the next turn', aliases: ['/q'], surface: exec() },
  { name: '/retry', description: 'Retry the last user message', surface: exec() },
  { name: '/rollback', description: 'List or restore filesystem checkpoints', surface: exec() },
  { name: '/save', description: 'Save the current transcript to JSON', surface: exec() },
  { name: '/status', description: 'Show current session status', surface: exec() },
  { name: '/steer', description: 'Steer the current run after the next tool call', surface: exec() },
  { name: '/stop', description: 'Stop running background processes', surface: exec() },
  { name: '/tools', description: 'List or toggle tools available to the agent', surface: exec(), args: true },
  { name: '/undo', description: 'Remove the last user/assistant exchange', surface: exec() },
  { name: '/usage', description: 'Show token usage for this session', surface: exec() },
  { name: '/version', description: 'Show Hermes Agent version', surface: exec() },

  // No desktop surface, but carry an alias (underscore spelling variants).
  { name: '/reload-mcp', aliases: ['/reload_mcp'], surface: unavailable('advanced') },
  { name: '/reload-skills', aliases: ['/reload_skills'], surface: unavailable('advanced') }
]

// Known commands with no desktop surface (and no alias) — a flat name list
// per reason beats 40 identical object literals.
const NO_DESKTOP_SURFACE: Record<DesktopUnavailableReason, readonly string[]> = {
  terminal: [
    '/busy', '/clear', '/compact', '/config', '/copy', '/cron', '/details',
    '/exit', '/footer', '/gateway', '/history', '/image', '/indicator', '/logs',
    '/mouse', '/paste', '/platforms', '/plugins', '/quit', '/redraw', '/reload', '/restart',
    '/sb', '/set-home', '/sethome', '/snap', '/snapshot', '/statusbar', '/toolsets', '/update', '/verbose'
  ],
  messaging: ['/approve', '/deny'],
  settings: ['/skills', '/pets'],
  advanced: ['/curator', '/fast', '/insights', '/kanban', '/reasoning', '/voice']
}

const ALL_SPECS: readonly DesktopCommandSpec[] = [
  ...DESKTOP_COMMAND_SPECS,
  ...(Object.entries(NO_DESKTOP_SURFACE) as [DesktopUnavailableReason, readonly string[]][]).flatMap(
    ([reason, names]) => names.map(name => ({ name, surface: unavailable(reason) }))
  )
]

const SPEC_BY_NAME = new Map<string, DesktopCommandSpec>(ALL_SPECS.map(spec => [spec.name, spec]))

const ALIAS_TO_CANONICAL = new Map<string, string>(
  ALL_SPECS.flatMap(spec => (spec.aliases ?? []).map(alias => [alias, spec.name] as const))
)

const UNAVAILABLE_MESSAGE: Record<DesktopUnavailableReason, (command: string) => string> = {
  advanced: command =>
    `${command} is not shown in the desktop slash palette. Use the relevant desktop control or terminal interface instead.`,
  messaging: command => `${command} is only used from messaging platforms.`,
  settings: command => `${command} is managed from the desktop sidebar.`,
  terminal: command => `${command} is only available in the terminal interface.`
}

const PICKER_UNAVAILABLE_MESSAGE: Record<DesktopPickerId, (command: string) => string> = {
  model: command => `${command} uses the desktop model picker instead of a slash command.`,
  session: command => `${command} uses the desktop session picker instead of a slash command.`
}

function normalizeCommand(command: string): string {
  const trimmed = command.trim()
  const base = (trimmed.startsWith('/') ? trimmed : `/${trimmed}`).split(/\s+/, 1)[0]?.toLowerCase() || ''

  return base
}

export function canonicalDesktopSlashCommand(command: string): string {
  const normalized = normalizeCommand(command)

  return DESKTOP_ALIASES.get(normalized) || normalized
}

export function isDesktopSlashCommand(command: string): boolean {
  const normalized = normalizeCommand(command)
  const canonical = canonicalDesktopSlashCommand(normalized)

  if (BLOCKED_COMMANDS.has(normalized) || BLOCKED_COMMANDS.has(canonical)) {
    return false
  }

  return DESKTOP_COMMANDS.has(canonical) || !isKnownHermesSlashCommand(normalized)
}

export function isDesktopSlashSuggestion(command: string): boolean {
  const normalized = normalizeCommand(command)
  const canonical = canonicalDesktopSlashCommand(normalized)

  return DESKTOP_COMMANDS.has(canonical) && !DESKTOP_ALIASES.has(normalized)
}

export function desktopSlashUnavailableMessage(command: string): string | null {
  const normalized = normalizeCommand(command)
  const canonical = canonicalDesktopSlashCommand(normalized)

  if (PICKER_OWNED_COMMANDS.has(canonical)) {
    return `/${canonical.slice(1)} uses the desktop model picker instead of a slash command.`
  }

  if (SETTINGS_OWNED_COMMANDS.has(canonical)) {
    return `/${canonical.slice(1)} is managed from the desktop sidebar.`
  }

  if (MESSAGING_ONLY_COMMANDS.has(canonical)) {
    return `/${canonical.slice(1)} is only used from messaging platforms.`
  }

  if (ADVANCED_COMMANDS.has(canonical)) {
    return `/${canonical.slice(1)} is not shown in the desktop slash palette. Use the relevant desktop control or terminal interface instead.`
  }

  if (TERMINAL_ONLY_COMMANDS.has(normalized) || TERMINAL_ONLY_COMMANDS.has(canonical)) {
    return `/${canonical.slice(1)} is only available in the terminal interface.`
  }

  return null
}

export function desktopSlashDescription(command: string, fallback = ''): string {
  const canonical = canonicalDesktopSlashCommand(command)

  return DESKTOP_COMMAND_DESCRIPTIONS.get(canonical) || fallback
}

export function desktopSkinSlashCompletions(
  themes: DesktopThemeCommandOption[],
  activeThemeName: string,
  argPrefix: string
): DesktopSlashCompletion[] {
  const prefix = argPrefix.trim().toLowerCase()

  const commands: DesktopSlashCompletion[] = [
    {
      text: '/skin list',
      display: '/skin list',
      meta: 'Show available desktop themes'
    },
    {
      text: '/skin next',
      display: '/skin next',
      meta: 'Cycle to the next desktop theme'
    },
    ...themes.map(theme => ({
      text: `/skin ${theme.name}`,
      display: `/skin ${theme.name}`,
      meta: `${theme.label}${theme.name === activeThemeName ? ' (current)' : ''} - ${theme.description}`
    }))
  ]

  if (!prefix) {
    return commands
  }

  return commands.filter(item => item.text.slice('/skin '.length).toLowerCase().startsWith(prefix))
}

export function filterDesktopCommandsCatalog(catalog: CommandsCatalogLike): CommandsCatalogLike {
  const categories = catalog.categories
    ?.map(section => ({
      ...section,
      pairs: section.pairs
        .filter(([command]) => isDesktopSlashSuggestion(command))
        .map(([command, description]) => [command, desktopSlashDescription(command, description)] as [string, string])
    }))
    .filter(section => section.pairs.length > 0)

  const pairs = catalog.pairs
    ?.filter(([command]) => isDesktopSlashSuggestion(command))
    .map(([command, description]) => [command, desktopSlashDescription(command, description)] as [string, string])

  return {
    ...catalog,
    ...(categories ? { categories } : {}),
    ...(pairs ? { pairs } : {})
  }
}

function isKnownHermesSlashCommand(command: string): boolean {
  return DESKTOP_COMMANDS.has(command) || DESKTOP_ALIASES.has(command) || BLOCKED_COMMANDS.has(command)
}
