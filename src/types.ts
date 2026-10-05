export type CueKind = 'dialogue' | 'sfx' | 'transition'
export type Rate = 0.8 | 0.9 | 1 | 1.1 | 1.2

export interface Character {
  id: string
  name: string
  voiceActor: string
  color: string
}

export interface SoundEffect {
  id: string
  name: string
  duration: number
  source: string
  note: string
}

export interface Cue {
  id: string
  kind: CueKind
  characterId?: string
  text: string
  emotion: string
  rate: Rate
  soundEffectId?: string
  transition: string
  manualDuration?: number
  /** 相对本场起点的锁定开始时间（秒）；未设置时按顺序自动排入。 */
  lockedStart?: number | null
}

export interface Scene {
  id: string
  code: string
  title: string
  location: string
  timeOfDay: string
  transition: string
  durationLimit: number
  cues: Cue[]
}

export interface StudioDocument {
  title: string
  subtitle: string
  targetDuration: number
  characters: Character[]
  soundEffects: SoundEffect[]
  scenes: Scene[]
  /** 每场音效通道数量，旧稿未设置时按 3 条补齐。 */
  sfxChannels?: number
  /** 结构版本号：旧稿（v1 纯时长排列）按顺序兼容补齐轨道时间。 */
  scheduleVersion?: number
}

export type TimelineTrack = 'main' | 'sfx'
export type ScheduleStatus = 'scheduled' | 'rejected'
export type ScheduleConflictType = 'actor-overlap' | 'track-overflow' | 'channel-full'

export interface ScheduledItem {
  cueId: string
  sceneId: string
  kind: CueKind
  track: TimelineTrack
  /** 音效通道序号（0 起），仅音效项有值。 */
  channel?: number
  /** 相对本场起点的开始时间（秒）。 */
  start: number
  end: number
  duration: number
  status: ScheduleStatus
  locked: boolean
  characterId?: string
  actor?: string
  /** 被拒绝或发生冲突的原因。 */
  reason?: ScheduleConflictType
}

export interface ScheduleConflict {
  type: ScheduleConflictType
  sceneId: string
  cueId?: string
  cueIds?: string[]
  detail: string
}

export interface SceneSchedule {
  sceneId: string
  items: ScheduledItem[]
  conflicts: ScheduleConflict[]
  /** 本场相对全剧的起点偏移（秒）。 */
  offset: number
  duration: number
}

export interface TimelineSchedule {
  scenes: SceneSchedule[]
  conflicts: ScheduleConflict[]
  totalDuration: number
  sfxChannels: number
  rejectedCount: number
}

export interface PendingChange {
  id: string
  label: string
  createdAt: string
  status: 'pending' | 'accepted' | 'rejected'
  before: StudioDocument
  after: StudioDocument
  note: string
}

export interface FrozenVersion {
  id: string
  name: string
  createdAt: string
  document: StudioDocument
  totalDuration: number
  /** 冻结时的轨道时间表快照。 */
  schedule?: TimelineSchedule
}

export interface StudioState {
  document: StudioDocument
  pending: PendingChange[]
  frozen: FrozenVersion[]
  updatedAt: string
}

export type WarningType =
  | 'collision'
  | 'missing-sfx'
  | 'over-time'
  | 'actor-overlap'
  | 'track-overflow'
  | 'channel-full'

export interface WarningItem {
  id: string
  type: WarningType
  level: 'error' | 'warning'
  sceneId: string
  cueId?: string
  title: string
  detail: string
}
