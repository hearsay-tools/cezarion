import { forwardRef, type SVGProps } from 'react'
import geometry from './design-icons/geometry.json'

/** Exact filled glyph outlines from the approved 193-frame cezarion.pen export.
 * Source SHA256: 56a71a27c7795137cab1c0a40a5839edecbacab4014d2d39ddc90f89343275f8.
 * These preserve the exported font geometry; they are not stroked Lucide substitutes.
 */
export type DesignIconName = keyof typeof geometry
export type DesignIconProps = SVGProps<SVGSVGElement> & { size?: number | string }
export const DesignIcon = forwardRef<SVGSVGElement, DesignIconProps & { name: DesignIconName }>(
  function DesignIcon({ name, size = 24, children, ...props }, ref) {
    const glyph = geometry[name]
    const labelled = Boolean(props['aria-label'] || props['aria-labelledby'])
    return <svg ref={ref} width={size} height={size} viewBox={glyph.viewBox}
      aria-hidden={labelled ? undefined : true} role={labelled ? 'img' : undefined}
      focusable="false" {...props} fill="currentColor" stroke="none" data-design-icon={name}>
      {glyph.paths.map((path, index) => <path key={index} d={path.d} />)}
      {children}
    </svg>
  },
)

function icon(name: DesignIconName) {
  const Component = forwardRef<SVGSVGElement, DesignIconProps>((props, ref) =>
    <DesignIcon {...props} ref={ref} name={name} />)
  Component.displayName = `DesignIcon(${name})`
  return Component
}

export const MenuIcon = icon("menu")
export const FolderIcon = icon("folder")
export const ChevronDownIcon = icon("chevron-down")
export const TerminalIcon = icon("terminal")
export const PaperclipIcon = icon("paperclip")
export const NotebookPenIcon = icon("notebook-pen")
export const SparklesIcon = icon("sparkles")
export const MicIcon = icon("mic")
export const CheckIcon = icon("check")
export const CpuIcon = icon("cpu")
export const GaugeIcon = icon("gauge")
export const ChevronUpIcon = icon("chevron-up")
export const ArrowUpIcon = icon("arrow-up")
export const ShieldCheckIcon = icon("shield-check")
export const SearchIcon = icon("search")
export const PlusIcon = icon("plus")
export const FolderOpenIcon = icon("folder-open")
export const ListTodoIcon = icon("list-todo")
export const GitBranchIcon = icon("git-branch")
export const GithubIcon = icon("github")
export const WorkflowIcon = icon("workflow")
export const SettingsIcon = icon("settings")
export const GitMergeIcon = icon("git-merge")
export const PinIcon = icon("pin")
export const GitPullRequestIcon = icon("git-pull-request")
export const CircleDotIcon = icon("circle-dot")
export const LayersIcon = icon("layers")
export const FolderPlusIcon = icon("folder-plus")
export const Settings2Icon = icon("settings-2")
export const WrenchIcon = icon("wrench")
export const SunMoonIcon = icon("sun-moon")
export const SlidersHorizontalIcon = icon("sliders-horizontal")
export const ChevronRightIcon = icon("chevron-right")
export const CircleCheckIcon = icon("circle-check")
export const BotIcon = icon("bot")
export const RefreshCwIcon = icon("refresh-cw")
export const FileCodeIcon = icon("file-code")
export const GitCommitHorizontalIcon = icon("git-commit-horizontal")
export const PaletteIcon = icon("palette")
export const DownloadIcon = icon("download")
export const ZapIcon = icon("zap")
export const XIcon = icon("x")
export const EllipsisIcon = icon("ellipsis")
export const MessagesSquareIcon = icon("messages-square")
export const ArchiveIcon = icon("archive")
export const ArrowUpRightIcon = icon("arrow-up-right")
export const AlignLeftIcon = icon("align-left")
export const Columns2Icon = icon("columns-2")
export const TagsIcon = icon("tags")
export const UsersIcon = icon("users")
export const SquareIcon = icon("square")
export const ListIcon = icon("list")
export const UploadIcon = icon("upload")
export const WandSparklesIcon = icon("wand-sparkles")
export const Trash2Icon = icon("trash-2")
export const ArrowDownIcon = icon("arrow-down")
export const CopyIcon = icon("copy")
export const BellIcon = icon("bell")
export const KeyRoundIcon = icon("key-round")
export const FoldersIcon = icon("folders")
export const FileDiffIcon = icon("file-diff")
export const FileSearchIcon = icon("file-search")
export const TriangleAlertIcon = icon("triangle-alert")
export const CircleIcon = icon("circle")
export const CircleXIcon = icon("circle-x")
export const GitPullRequestDraftIcon = icon("git-pull-request-draft")
export const MessageSquareWarningIcon = icon("message-square-warning")
export const GitPullRequestClosedIcon = icon("git-pull-request-closed")
export const CircleSlashIcon = icon("circle-slash")
export const ArrowRightIcon = icon("arrow-right")
export const GripVerticalIcon = icon("grip-vertical")
export const ArrowLeftIcon = icon("arrow-left")
export const MinusIcon = icon("minus")
export const SquareCheckIcon = icon("square-check")
export const InboxIcon = icon("inbox")
export const UserRoundIcon = icon("user-round")
