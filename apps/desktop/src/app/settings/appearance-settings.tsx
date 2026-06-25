import { useStore } from '@nanostores/react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import { LanguageSwitcher } from '@/components/language-switcher'
import { SegmentedControl } from '@/components/ui/segmented-control'
import type { DesktopMarketplaceSearchItem } from '@/global'
import { useI18n } from '@/i18n'
import { triggerHaptic } from '@/lib/haptics'
import { Check, Download, Loader2, Palette, Trash2 } from '@/lib/icons'
import { selectableCardClass } from '@/lib/selectable-card'
import { cn } from '@/lib/utils'
import { $toolViewMode, setToolViewMode } from '@/store/tool-view'
import { $translucency, setTranslucency } from '@/store/translucency'
import { getBaseColors, useTheme } from '@/themes/context'
import { installVscodeThemeFromMarketplace } from '@/themes/install'
import { isUserTheme, removeUserTheme } from '@/themes/user-themes'

import { MODE_OPTIONS } from './constants'
import { PetSettings } from './pet-settings'
import { ListRow, SectionHeading, SettingsContent } from './primitives'

function ThemePreview({ name, mode }: { name: string; mode: 'light' | 'dark' }) {
  // Preview in the *current* mode: the dark palette in Dark, and the light
  // palette in Light — synthesizing one for dark-only themes — so every card
  // tracks the Light/Dark toggle, exactly like the app itself does.
  const c = getBaseColors(name, mode)

  return (
    <div
      className="h-20 overflow-hidden rounded-xl border shadow-xs"
      style={{ backgroundColor: c.background, borderColor: c.border }}
    >
      <div className="flex h-full">
        <div
          className="w-12 border-r"
          style={{
            backgroundColor: c.sidebarBackground ?? c.muted,
            borderColor: c.sidebarBorder ?? c.border
          }}
        />
        <div className="flex flex-1 flex-col gap-2 p-3">
          <div className="h-2.5 w-16 rounded-full" style={{ backgroundColor: c.foreground }} />
          <div className="h-2 w-24 rounded-full" style={{ backgroundColor: c.mutedForeground }} />
          <div className="mt-auto flex justify-end">
            <div
              className="h-5 w-16 rounded-full border"
              style={{
                backgroundColor: c.userBubble ?? c.muted,
                borderColor: c.userBubbleBorder ?? c.border
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs)

    return () => clearTimeout(handle)
  }, [value, delayMs])

  return debounced
}

const compactNumber = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })

/**
 * Live VS Code Marketplace theme search (the same backend as the Cmd-K "Install
 * theme…" page). Renders below the local grid when there's a query: each row
 * downloads + converts + installs via `installVscodeThemeFromMarketplace` and
 * activates it. Extensions already imported locally are marked installed.
 */
function MarketplaceThemeResults({
  query,
  installedExtIds,
  onInstalled
}: {
  query: string
  installedExtIds: Set<string>
  onInstalled: (name: string) => void
}) {
  const { t } = useI18n()
  const copy = t.commandCenter.installTheme
  const debounced = useDebounced(query.trim(), 300)
  const [installingId, setInstallingId] = useState<string | null>(null)
  const [installedHere, setInstalledHere] = useState<Record<string, true>>({})
  const [error, setError] = useState<string | null>(null)

  const search = useQuery({
    enabled: debounced.length > 0,
    queryFn: () => window.hermesDesktop?.themes?.searchMarketplace(debounced) ?? Promise.resolve([]),
    queryKey: ['marketplace-themes-settings', debounced],
    staleTime: 5 * 60 * 1000
  })

  const install = async (item: DesktopMarketplaceSearchItem) => {
    if (installingId) {
      return
    }

    setInstallingId(item.extensionId)
    setError(null)

    try {
      const theme = await installVscodeThemeFromMarketplace(item.extensionId)

      triggerHaptic('crisp')
      setInstalledHere(prev => ({ ...prev, [item.extensionId]: true }))
      onInstalled(theme.name)
    } catch (e) {
      setError(e instanceof Error ? e.message : copy.error)
    } finally {
      setInstallingId(null)
    }
  }

  if (!debounced) {
    return null
  }

  const header = (
    <p className="mb-2 mt-4 text-[length:var(--conversation-caption-font-size)] font-medium text-(--ui-text-tertiary)">
      From the VS Code Marketplace
    </p>
  )

  if (search.isLoading) {
    return (
      <>
        {header}
        <p className="flex items-center gap-2 text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
          <Loader2 className="size-3.5 animate-spin" />
          {copy.loading}
        </p>
      </>
    )
  }

  if (search.isError) {
    return (
      <>
        {header}
        <p className="text-[length:var(--conversation-caption-font-size)] text-(--ui-red)">{copy.error}</p>
      </>
    )
  }

  const results = search.data ?? []

  if (results.length === 0) {
    return (
      <>
        {header}
        <p className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">{copy.empty}</p>
      </>
    )
  }

  return (
    <>
      {header}
      {error && <p className="mb-2 text-[length:var(--conversation-caption-font-size)] text-(--ui-red)">{error}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        {results.map(item => {
          const busy = installingId === item.extensionId
          const done = installedHere[item.extensionId] || installedExtIds.has(item.extensionId)

          return (
            <button
              className={cn(
                'flex items-center gap-2.5 px-2.5 py-2 text-left disabled:opacity-60',
                selectableCardClass({ prominent: done })
              )}
              disabled={Boolean(installingId) && !busy}
              key={item.extensionId}
              onClick={() => void install(item)}
              type="button"
            >
              <Palette className="size-4 shrink-0 text-(--ui-text-tertiary)" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[length:var(--conversation-text-font-size)] font-medium">
                  {item.displayName}
                </span>
                <span className="block truncate text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
                  {item.publisher}
                  {item.installs > 0 ? ` · ${copy.installs(compactNumber.format(item.installs))}` : ''}
                </span>
              </span>
              <span className="shrink-0 text-(--ui-text-tertiary)">
                {busy ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : done ? (
                  <Check className="size-4 text-(--ui-green)" />
                ) : (
                  <Download className="size-4" />
                )}
              </span>
            </button>
          )
        })}
      </div>
    </>
  )
}

export function AppearanceSettings() {
  const { t, isSavingLocale } = useI18n()
  const { themeName, mode, resolvedMode, availableThemes, setTheme, setMode } = useTheme()
  const toolViewMode = useStore($toolViewMode)
  const translucency = useStore($translucency)
  const profiles = useStore($profiles)
  const activeProfileKey = normalizeProfileKey(useStore($activeGatewayProfile))
  const a = t.settings.appearance

  const [query, setQuery] = useState('')

  // One box does double duty: filter installed themes live (below), and run a
  // name search against the VS Code Marketplace (the Cmd-K "Install theme…"
  // backend) for anything not already installed.
  const needle = query.trim().toLowerCase()

  const filteredThemes = availableThemes
    .filter(
      theme =>
        !needle ||
        theme.label.toLowerCase().includes(needle) ||
        theme.name.toLowerCase().includes(needle) ||
        theme.description.toLowerCase().includes(needle)
    )
    // Active theme first; stable sort keeps the rest in their original order.
    .sort((a, b) => Number(b.name === themeName) - Number(a.name === themeName))

  // Marketplace imports describe themselves as "VS Code · <publisher.extension>";
  // pull those ids back out so search results already imported show as installed.
  const MARKETPLACE_DESC_PREFIX = 'VS Code · '

  const installedExtIds = new Set(
    availableThemes
      .map(theme =>
        theme.description.startsWith(MARKETPLACE_DESC_PREFIX)
          ? theme.description.slice(MARKETPLACE_DESC_PREFIX.length)
          : ''
      )
      .filter(Boolean)
  )

  // Themes save per profile. Surface that only when the user actually has more
  // than one profile (single-profile installs never see the distinction).
  const showProfileNote = profiles.length > 1

  const activeProfileName =
    profiles.find(profile => normalizeProfileKey(profile.name) === activeProfileKey)?.name ?? activeProfileKey

  const modeOptions = MODE_OPTIONS.map(({ id, icon }) => ({ icon, id, label: t.settings.modeOptions[id].label }))

  const toolOptions = [
    { id: 'product', label: a.product },
    { id: 'technical', label: a.technical }
  ] as const

  return (
    <SettingsContent>
      <div>
        <SectionHeading icon={Palette} title={a.title} />
        <p className="max-w-2xl text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
          {a.intro}
        </p>

        <div className="mt-2">
          <ListRow
            action={<LanguageSwitcher />}
            description={isSavingLocale ? t.language.saving : t.language.description}
            title={t.language.label}
          />

          <ListRow
            below={
              <>
                {/* One search box: filters your installed themes (the grid)
                    and live-searches the VS Code Marketplace below. */}
                <div className="mt-3">
                  <input
                    className="w-full rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) px-3 py-1.5 text-[length:var(--conversation-caption-font-size)] outline-none placeholder:text-(--ui-text-tertiary) focus:border-(--ui-stroke-secondary)"
                    onChange={event => setQuery(event.target.value)}
                    placeholder="Search your themes or the VS Code Marketplace…"
                    spellCheck={false}
                    value={query}
                  />
                </div>

                {/* Fixed-height scroll area so the (growing) theme list never
                    runs the page long; the grid scrolls inside it. */}
                <div className="mt-3 max-h-96 overflow-y-auto pr-1">
                  {filteredThemes.length === 0 ? (
                    needle ? (
                      <p className="text-[length:var(--conversation-caption-font-size)] text-(--ui-text-tertiary)">
                        No installed themes match "{query.trim()}".
                      </p>
                    ) : null
                  ) : (
                    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {filteredThemes.map(theme => {
                        const active = themeName === theme.name
                        const removable = isUserTheme(theme.name)

                        return (
                          <div className="group relative" key={theme.name}>
                            <button
                              className={cn('w-full p-2 text-left', selectableCardClass({ active, prominent: true }))}
                              onClick={() => {
                                triggerHaptic('crisp')
                                setTheme(theme.name)
                              }}
                              type="button"
                            >
                              <ThemePreview mode={resolvedMode} name={theme.name} />
                              <div className="mt-3 px-1">
                                <div className="truncate text-[length:var(--conversation-text-font-size)] font-medium">
                                  {theme.label}
                                </div>
                                <div className="mt-0.5 line-clamp-2 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
                                  {theme.description}
                                </div>
                              </div>
                            </button>
                            {removable && (
                              <button
                                aria-label={a.removeTheme}
                                className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-md bg-(--ui-bg-elevated)/80 text-(--ui-text-tertiary) opacity-0 backdrop-blur-sm transition hover:text-(--ui-red) focus-visible:opacity-100 group-hover:opacity-100"
                                onClick={() => {
                                  triggerHaptic('crisp')
                                  removeUserTheme(theme.name)

                                  // Re-normalize off the now-missing skin → default.
                                  if (active) {
                                    setTheme(theme.name)
                                  }
                                }}
                                title={a.removeTheme}
                                type="button"
                              >
                                <Trash2 className="size-3.5" />
                              </button>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  )}
                  <MarketplaceThemeResults
                    installedExtIds={installedExtIds}
                    onInstalled={name => setTheme(name)}
                    query={query}
                  />
                </div>
                {showProfileNote && (
                  <p className="mt-3 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
                    {a.themeProfileNote(activeProfileName)}
                  </p>
                )}
              </>
            }
            description={a.themeDesc}
            title={
              <div className="flex items-center justify-between gap-3">
                <span>{a.themeTitle}</span>
                <SegmentedControl
                  onChange={id => {
                    triggerHaptic('crisp')
                    setMode(id)
                  }}
                  options={modeOptions}
                  value={mode}
                />
              </div>
            }
            wide
          />

          <ListRow
            action={
              <div className="flex items-center gap-3">
                <input
                  aria-label={a.translucencyTitle}
                  className="h-1 w-40 cursor-pointer appearance-none rounded-full bg-(--ui-stroke-tertiary)"
                  max={100}
                  min={0}
                  onChange={event => {
                    triggerHaptic('selection')
                    setTranslucency(Number(event.target.value))
                  }}
                  step={5}
                  style={{ accentColor: 'var(--dt-primary)' }}
                  type="range"
                  value={translucency}
                />
                <span className="w-9 text-right text-[length:var(--conversation-caption-font-size)] tabular-nums text-(--ui-text-tertiary)">
                  {translucency}%
                </span>
              </div>
            }
            description={a.translucencyDesc}
            title={a.translucencyTitle}
          />

          <ListRow
            action={
              <SegmentedControl
                onChange={id => {
                  triggerHaptic('selection')
                  setToolViewMode(id)
                }}
                options={toolOptions}
                value={toolViewMode}
              />
            }
            description={a.toolViewDesc}
            title={a.toolViewTitle}
          />
        </div>

        <section className="rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-chat-bubble-background) p-3 shadow-sm">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">Color Mode</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Pick a fixed mode or let Hermes follow your system setting.
              </div>
            </div>
            <Pill>{prettyName(mode)}</Pill>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            {MODE_OPTIONS.map(({ id, label, description, icon: Icon }) => {
              const active = mode === id

              return (
                <button
                  className={cn(
                    'group rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) p-2.5 text-left transition hover:bg-(--chrome-action-hover)',
                    active && 'border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary)'
                  )}
                  key={id}
                  onClick={() => {
                    triggerHaptic('crisp')
                    setMode(id)
                  }}
                  type="button"
                >
                  <div className="flex items-start justify-between gap-3">
                    <span className="flex size-9 items-center justify-center rounded-lg bg-muted text-foreground transition group-hover:bg-background">
                      <Icon className="size-4" />
                    </span>
                    {active && (
                      <span className="grid size-5 place-items-center rounded-full bg-primary text-primary-foreground">
                        <Check className="size-3.5" />
                      </span>
                    )}
                  </div>
                  <div className="mt-2 text-[length:var(--conversation-text-font-size)] font-medium">{label}</div>
                  <div className="mt-1 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
                    {description}
                  </div>
                </button>
              )
            })}
          </div>
        </section>

        <section className="rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-chat-bubble-background) p-3 shadow-sm">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">Tool Call Display</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Product hides raw tool payloads; Technical shows full input/output.
              </div>
            </div>
            <Pill>{toolViewMode === 'technical' ? 'Technical' : 'Product'}</Pill>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                {
                  id: 'product',
                  label: 'Product',
                  description: 'Human-friendly tool activity with concise summaries.'
                },
                {
                  id: 'technical',
                  label: 'Technical',
                  description: 'Include raw tool args/results and low-level details.'
                }
              ] as const
            ).map(option => {
              const active = toolViewMode === option.id

              return (
                <button
                  className={cn(
                    'group rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) p-2.5 text-left transition hover:bg-(--chrome-action-hover)',
                    active && 'border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary)'
                  )}
                  key={option.id}
                  onClick={() => {
                    triggerHaptic('selection')
                    setToolViewMode(option.id)
                  }}
                  type="button"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="text-[length:var(--conversation-text-font-size)] font-medium">{option.label}</div>
                    {active && (
                      <span className="grid size-5 place-items-center rounded-full bg-primary text-primary-foreground">
                        <Check className="size-3.5" />
                      </span>
                    )}
                  </div>
                  <div className="mt-1 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
                    {option.description}
                  </div>
                </button>
              )
            })}
          </div>
        </section>

        <section className="rounded-xl border border-(--ui-stroke-tertiary) bg-(--ui-chat-bubble-background) p-3 shadow-sm">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-sm font-medium">Theme</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Desktop palettes only. The selected mode is applied on top.
              </div>
            </div>
            {activeTheme && <Pill>{activeTheme.label}</Pill>}
          </div>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {availableThemes.map(theme => {
              const active = themeName === theme.name

              return (
                <button
                  className={cn(
                    'rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-bg-quinary) p-2 text-left transition hover:bg-(--chrome-action-hover)',
                    active && 'border-(--ui-stroke-secondary) bg-(--ui-bg-tertiary)'
                  )}
                  key={theme.name}
                  onClick={() => {
                    triggerHaptic('crisp')
                    setTheme(theme.name)
                  }}
                  type="button"
                >
                  <ThemePreview name={theme.name} />
                  <div className="mt-3 flex items-start justify-between gap-3 px-1">
                    <div className="min-w-0">
                      <div className="truncate text-[length:var(--conversation-text-font-size)] font-medium">
                        {theme.label}
                      </div>
                      <div className="mt-0.5 line-clamp-2 text-[length:var(--conversation-caption-font-size)] leading-(--conversation-caption-line-height) text-(--ui-text-tertiary)">
                        {theme.description}
                      </div>
                    </div>
                    {active && (
                      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground">
                        <Check className="size-3.5" />
                      </span>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        </section>
      </div>

      <div className="mt-6">
        <PetSettings />
      </div>
    </SettingsContent>
  )
}
