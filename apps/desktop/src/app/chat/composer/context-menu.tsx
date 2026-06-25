import { useState } from 'react'

import { composerPanelCard } from '@/components/chat/composer-dock'
import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Kbd } from '@/components/ui/kbd'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { Clipboard, FileText, FolderOpen, type IconComponent, ImageIcon, Link, MessageSquareText } from '@/lib/icons'
import { cn } from '@/lib/utils'

import { GHOST_ICON_BTN } from './controls'
import type { ChatBarState } from './types'

export function ContextMenu({
  state,
  onInsertText,
  onOpenUrlDialog,
  onPasteClipboardImage,
  onPickFiles,
  onPickFolders,
  onPickImages
}: {
  state: ChatBarState
  onInsertText: (text: string) => void
  onOpenUrlDialog: () => void
  onPasteClipboardImage?: () => void
  onPickFiles?: () => void
  onPickFolders?: () => void
  onPickImages?: () => void
}) {
  return (
    <>
      <DropdownMenu>
        <Tip label={state.tools.label} side="top">
          <DropdownMenuTrigger asChild>
            <Button
              aria-label={state.tools.label}
              className={cn(
                GHOST_ICON_BTN,
                'data-[state=open]:bg-(--chrome-action-hover) data-[state=open]:text-foreground'
              )}
              disabled={!state.tools.enabled}
              size="icon"
              type="button"
              variant="ghost"
            >
              <Codicon name="add" size="0.875rem" />
            </Button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent align="start" className={cn('w-60', composerPanelCard)} side="top" sideOffset={6}>
          <DropdownMenuLabel className="px-2 pb-0.5 pt-0.5 text-[0.625rem] font-semibold uppercase tracking-wider text-(--ui-text-tertiary)">
            {c.attachLabel}
          </DropdownMenuLabel>
          <ContextMenuItem disabled={!onPickFiles} icon={FileText} onSelect={onPickFiles}>
            {c.files}
          </ContextMenuItem>
          <ContextMenuItem disabled={!onPickFolders} icon={FolderOpen} onSelect={onPickFolders}>
            {c.folder}
          </ContextMenuItem>
          <ContextMenuItem disabled={!onPickImages} icon={ImageIcon} onSelect={onPickImages}>
            {c.images}
          </ContextMenuItem>
          <ContextMenuItem disabled={!onPasteClipboardImage} icon={Clipboard} onSelect={onPasteClipboardImage}>
            {c.pasteImage}
          </ContextMenuItem>
          <ContextMenuItem icon={Link} onSelect={onOpenUrlDialog}>
            {c.url}
          </ContextMenuItem>

        <DropdownMenuSeparator />

        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <MessageSquareText />
            <span>Prompt snippets</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="w-72">
            {[
              { label: 'Code review', text: 'Please review this for bugs, regressions, and missing tests.' },
              { label: 'Implementation plan', text: 'Please make a concise implementation plan before changing code.' },
              { label: 'Explain this', text: 'Please explain how this works and point me to the key files.' }
            ].map(snippet => (
              <ContextMenuItem icon={MessageSquareText} key={snippet.label} onSelect={() => onInsertText(snippet.text)}>
                {snippet.label}
              </ContextMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>

        <DropdownMenuSeparator />

        <div className="px-2 py-1 text-[0.7rem] text-muted-foreground/80">
          Tip: type <kbd className="rounded bg-muted/70 px-1 py-px font-mono text-[0.65rem]">@</kbd> to reference files
          inline.
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function ContextMenuItem({
  children,
  disabled,
  icon: Icon,
  onSelect
}: {
  children: string
  disabled?: boolean
  icon: IconComponent
  onSelect?: () => void
}) {
  return (
    // Override font size + highlight to match the / · @ completion rows exactly.
    <DropdownMenuItem
      className="text-[length:var(--conversation-tool-font-size)] focus:bg-(--ui-bg-tertiary)"
      disabled={disabled}
      onSelect={onSelect}
    >
      <Icon />
      <span>{children}</span>
    </DropdownMenuItem>
  )
}
