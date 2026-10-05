export type CueKind = 'dialogue' | 'sfx' | 'transition'
export type Rate = 0.8 | 0.9 | 1 | 1.1 | 1.2
export type TrackId = 'main' | 'sfx-1' | 'sfx-2' | 'sfx-3'

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
  /** 锁定起点（相对本场起点的秒数）；锁定后重排不会移动该提示。未设置时跟随主轨流式排布。 */
  lockedStart?: number
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

export interface CuePlacement {
  cueId: string
  sceneId: string
  kind: CueKind
  track: TrackId | null
  start: number
  end: number
  duration: number
  status: 'placed' | 'rejected'
  locked: boolean
}

export type ScheduleConflictType =
  | 'actor-overlap'
  | 'track-overlap'
  | 'channel-full'
  | 'invalid-locked-start'

export interface ScheduleConflict {
  type: ScheduleConflictType
  level: 'error' | 'warning'
  sceneId: string
  cueId: string
  title: string
  detail: string
}

export interface SceneSchedule {
  sceneId: string
  start: number
  span: number
  placements: CuePlacement[]
  conflicts: ScheduleConflict[]
  rejected: CuePlacement[]
}

export interface Timetable {
  scenes: SceneSchedule[]
  conflicts: ScheduleConflict[]
  totalDuration: number
}

export interface FrozenVersion {
  id: string
  name: string
  createdAt: string
  document: StudioDocument
  totalDuration: number
  /** 冻结时计算的带轨道时间表；旧版冻结稿没有该字段，导出时按顺序补齐。 */
  timetable?: Timetable
}

export interface StudioState {
  document: StudioDocument
  pending: PendingChange[]
  frozen: FrozenVersion[]
  updatedAt: string
}

export interface WarningItem {
  id: string
  type: 'collision' | 'missing-sfx' | 'over-time' | ScheduleConflictType
  level: 'error' | 'warning'
  sceneId: string
  cueId?: string
  title: string
  detail: string
}
