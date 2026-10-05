import type {
  Cue,
  Rate,
  ScheduleConflict,
  ScheduledItem,
  Scene,
  SceneSchedule,
  SoundEffect,
  StudioDocument,
  TimelineSchedule
} from './types'

/** 旧稿（无时间表字段）的结构版本；v2 起按轨道时间表排程。 */
export const SCHEDULE_VERSION = 2
export const DEFAULT_SFX_CHANNELS = 3
const EPS = 0.05

const round1 = (value: number) => Math.round(value * 10) / 10

export function effectiveRate(rate: Rate | undefined): number {
  return rate && rate > 0 ? rate : 1
}

/** 单项时长估算：手动覆盖 > 素材时长 > 台词字数/语速+标点停顿 > 转场 3 秒。 */
export function cueDuration(cue: Cue, effects: SoundEffect[]): number {
  if (cue.manualDuration !== undefined && cue.manualDuration !== null) return cue.manualDuration
  if (cue.kind === 'sfx') {
    return effects.find((effect) => effect.id === cue.soundEffectId)?.duration ?? 6
  }
  if (cue.kind === 'transition') return 3
  const pauses = (cue.text.match(/[，。！？；、…]/g)?.length ?? 0) * 0.22
  return Number((cue.text.length / (4.2 * effectiveRate(cue.rate)) + pauses).toFixed(1))
}

function overlaps(a: ScheduledItem, b: ScheduledItem): boolean {
  return a.start < b.end - EPS && b.start < a.end - EPS
}

/**
 * 把全剧提示序列编成轨道时间表：
 * - 台词与转场顺序占据主轨，转场接在主轨前一项末尾；
 * - 音效按场次分配到固定数量（默认 3 条）的音效通道，起点锚定主轨前一项末尾；
 * - 已锁定起点的项目保持不动，其后项目从受影响处向后重排；
 * - 同演员的台词区间不能重叠；通道满载的音效按场次拒绝并标出。
 */
export function buildSchedule(document: StudioDocument, channelCount = DEFAULT_SFX_CHANNELS): TimelineSchedule {
  const channels = Math.max(1, Math.floor(channelCount) || DEFAULT_SFX_CHANNELS)
  const sceneSchedules: SceneSchedule[] = []
  const allConflicts: ScheduleConflict[] = []
  let globalOffset = 0

  for (const scene of document.scenes) {
    const { items, conflicts, duration } = scheduleScene(scene, document, channels)
    const sceneSchedule: SceneSchedule = {
      sceneId: scene.id,
      items,
      conflicts,
      offset: globalOffset,
      duration
    }
    sceneSchedules.push(sceneSchedule)
    allConflicts.push(...conflicts)
    globalOffset = round1(globalOffset + duration)
  }

  return {
    scenes: sceneSchedules,
    conflicts: allConflicts,
    totalDuration: globalOffset,
    sfxChannels: channels,
    rejectedCount: sceneSchedules.reduce(
      (total, scene) => total + scene.items.filter((item) => item.status === 'rejected').length,
      0
    )
  }
}

function scheduleScene(scene: Scene, document: StudioDocument, channels: number) {
  const items: ScheduledItem[] = []
  const conflicts: ScheduleConflict[] = []
  const mainItems: ScheduledItem[] = []
  // 每条通道内已排入的音效（按起点排序），用于容量检测。
  const laneSfx: ScheduledItem[][] = Array.from({ length: channels }, () => [])
  let mainCursor = 0

  const actorOf = (cue: Cue) =>
    document.characters.find((character) => character.id === cue.characterId)?.voiceActor

  for (const cue of scene.cues) {
    const duration = round1(cueDuration(cue, document.soundEffects))

    if (cue.kind === 'sfx') {
      // 音效起点锚定当前主轨末尾（即主轨前一项的结束时间）。
      const desiredStart = typeof cue.lockedStart === 'number' ? round1(cue.lockedStart) : mainCursor
      const laneIndex = laneSfx.findIndex((lane) =>
        lane.every((placed) => !overlaps({ start: desiredStart, end: round1(desiredStart + duration) } as ScheduledItem, placed))
      )
      if (laneIndex < 0) {
        // 三条通道容量不足：本场本批拒绝，明确标出。
        const item: ScheduledItem = {
          cueId: cue.id,
          sceneId: scene.id,
          kind: 'sfx',
          track: 'sfx',
          start: desiredStart,
          end: round1(desiredStart + duration),
          duration,
          status: 'rejected',
          locked: false,
          reason: 'channel-full'
        }
        items.push(item)
        conflicts.push({
          type: 'channel-full',
          sceneId: scene.id,
          cueId: cue.id,
          detail: `音效“${cue.text}”在 ${fmtTime(desiredStart)} 排入时，${channels} 条音效通道全部被占用，已拒绝；请调整位置或拆分到其他场次。`
        })
      } else {
        const item: ScheduledItem = {
          cueId: cue.id,
          sceneId: scene.id,
          kind: 'sfx',
          track: 'sfx',
          channel: laneIndex,
          start: desiredStart,
          end: round1(desiredStart + duration),
          duration,
          status: 'scheduled',
          locked: typeof cue.lockedStart === 'number'
        }
        insertByStart(laneSfx[laneIndex], item)
        items.push(item)
      }
      // 音效不推进主轨。
      continue
    }

    // 台词 / 转场占据主轨：锁定起点保持不动，否则接在前一项末尾。
    const start = typeof cue.lockedStart === 'number' ? round1(cue.lockedStart) : mainCursor
    const item: ScheduledItem = {
      cueId: cue.id,
      sceneId: scene.id,
      kind: cue.kind,
      track: 'main',
      start,
      end: round1(start + duration),
      duration,
      status: 'scheduled',
      locked: typeof cue.lockedStart === 'number',
      characterId: cue.characterId,
      actor: cue.kind === 'dialogue' ? actorOf(cue) : undefined
    }
    const previous = mainItems[mainItems.length - 1]
    if (previous && start < previous.end - EPS) {
      // 主轨是单通道顺序轨，区间交叠排不进去。
      item.reason = 'track-overflow'
      conflicts.push({
        type: 'track-overflow',
        sceneId: scene.id,
        cueId: cue.id,
        cueIds: [previous.cueId, cue.id],
        detail: `主轨在 ${fmtTime(start)} 排不进“${cue.text.slice(0, 12)}”（${duration}s）：前一项到 ${fmtTime(previous.end)} 才结束，锁定起点造成主轨交叠。`
      })
    }
    mainItems.push(item)
    items.push(item)
    mainCursor = item.end
  }

  // 同一演员的台词区间不能重叠（锁定项把后续项顶住时才可能发生）。
  for (let i = 0; i < mainItems.length; i += 1) {
    for (let j = i + 1; j < mainItems.length; j += 1) {
      const a = mainItems[i]
      const b = mainItems[j]
      if (a.kind !== 'dialogue' || b.kind !== 'dialogue') continue
      if (!a.actor || a.actor !== b.actor) continue
      if (!overlaps(a, b)) continue
      if (a.reason !== 'track-overflow' && b.reason !== 'track-overflow') {
        a.reason = a.reason ?? 'actor-overlap'
        b.reason = b.reason ?? 'actor-overlap'
      }
      conflicts.push({
        type: 'actor-overlap',
        sceneId: scene.id,
        cueIds: [a.cueId, b.cueId],
        detail: `演员 ${a.actor} 的两段台词在 ${fmtTime(Math.max(a.start, b.start))} 附近重叠（${fmtTime(a.start)}–${fmtTime(a.end)} 与 ${fmtTime(b.start)}–${fmtTime(b.end)}），无法兼顾。`
      })
    }
  }

  const scheduled = items.filter((item) => item.status === 'scheduled')
  const duration = round1(scheduled.reduce((max, item) => Math.max(max, item.end), 0))
  return { items, conflicts, duration }
}

function insertByStart(list: ScheduledItem[], item: ScheduledItem) {
  const index = list.findIndex((placed) => placed.start > item.start)
  list.splice(index < 0 ? list.length : index, 0, item)
}

export function fmtTime(seconds: number): string {
  const value = Math.max(0, seconds)
  const mm = Math.floor(value / 60)
  const ss = value - mm * 60
  return `${String(mm).padStart(2, '0')}:${ss.toFixed(1).padStart(4, '0')}`
}

/** 旧稿没有时间表设置时，按顺序补齐默认通道与结构版本（就地补全）。 */
export function migrateDocument(document: StudioDocument): StudioDocument {
  if (!document.sfxChannels || document.sfxChannels < 1) document.sfxChannels = DEFAULT_SFX_CHANNELS
  if (!document.scheduleVersion) document.scheduleVersion = SCHEDULE_VERSION
  for (const scene of document.scenes) {
    for (const cue of scene.cues) {
      if (cue.lockedStart === undefined) cue.lockedStart = null
    }
  }
  return document
}

const kindLabel = (cue: Cue) => (cue.kind === 'dialogue' ? '台词' : cue.kind === 'sfx' ? '音效' : '转场')

/**
 * 生成带轨道时间的制作稿纯文本。冻结稿自带时间表；
 * 旧稿（无 scheduleVersion）按顺序兼容补齐后同样输出轨道起止。
 */
export function buildScript(document: StudioDocument, schedule: TimelineSchedule): string {
  const lines = [
    document.title,
    document.subtitle,
    `目标时长：${document.targetDuration} 秒｜排程总时长：${schedule.totalDuration.toFixed(1)} 秒`,
    `音效通道：每场 ${schedule.sfxChannels} 条`,
    '='.repeat(52),
    ''
  ]

  document.scenes.forEach((scene, sceneIndex) => {
    const sceneSchedule = schedule.scenes[sceneIndex]
    const rejected = sceneSchedule.items.filter((item) => item.status === 'rejected')
    lines.push(`${scene.code}｜${scene.title}`)
    lines.push(`场景：${scene.location} / ${scene.timeOfDay}`)
    lines.push(`转场：${scene.transition}`)
    lines.push(
      `场次限额：${scene.durationLimit} 秒｜轨道时长：${sceneSchedule.duration.toFixed(1)} 秒` +
        `｜全剧起点：${fmtTime(sceneSchedule.offset)}` +
        (rejected.length ? `｜拒绝音效 ${rejected.length} 条` : '')
    )
    lines.push('-'.repeat(38))

    // 主轨：按提示序列顺序输出；音效通道按通道分组输出。
    const mainItems = sceneSchedule.items.filter((item) => item.track === 'main')
    mainItems.forEach((item, index) => {
      const cue = scene.cues.find((entry) => entry.id === item.cueId)
      if (!cue) return
      const prefix = `${String(index + 1).padStart(2, '0')} [主轨 ${fmtTime(item.start)}→${fmtTime(item.end)}${item.locked ? ' · 锁定' : ''}]`
      if (cue.kind === 'dialogue') {
        const role = document.characters.find((character) => character.id === cue.characterId)?.name ?? '未指定角色'
        const actor = document.characters.find((character) => character.id === cue.characterId)?.voiceActor
        lines.push(`${prefix} 台词｜${role}${actor ? `（${actor}）` : ''}｜${cue.emotion || '自然'}｜语速 ${cue.rate}`)
        lines.push(`    ${cue.text}`)
      } else {
        lines.push(`${prefix} 转场｜${cue.transition}｜${cue.text}`)
      }
    })

    for (let channel = 0; channel < schedule.sfxChannels; channel += 1) {
      const sfxItems = sceneSchedule.items.filter(
        (item) => item.track === 'sfx' && item.status === 'scheduled' && item.channel === channel
      )
      if (!sfxItems.length) continue
      lines.push(`— 音效通道 ${String.fromCharCode(65 + channel)} —`)
      for (const item of sfxItems) {
        const cue = scene.cues.find((entry) => entry.id === item.cueId)
        if (!cue) continue
        const effect = document.soundEffects.find((entry) => entry.id === cue.soundEffectId)
        lines.push(
          `   [FX${channel + 1} ${fmtTime(item.start)}→${fmtTime(item.end)}${item.locked ? ' · 锁定' : ''}] 音效｜${cue.text}`
        )
        lines.push(`        文件：${effect?.source ?? '缺失引用'}｜${effect?.note ?? '需补齐音效'}`)
      }
    }

    for (const item of rejected) {
      const cue = scene.cues.find((entry) => entry.id === item.cueId)
      if (!cue) continue
      lines.push(`   [拒绝 @${fmtTime(item.start)}] 音效｜${cue.text}｜${schedule.sfxChannels} 条通道满载，未排入时间表`)
    }

    if (sceneSchedule.conflicts.length) {
      lines.push('冲突：')
      for (const conflict of sceneSchedule.conflicts) {
        lines.push(`  · ${conflict.detail}`)
      }
    }
    if (sceneIndex < document.scenes.length - 1) lines.push('')
  })

  const rejectedTotal = schedule.rejectedCount
  if (schedule.conflicts.length || rejectedTotal) {
    lines.push('='.repeat(52))
    lines.push(`排程冲突 ${schedule.conflicts.length} 项｜被拒绝提示 ${rejectedTotal} 条，请在录音前处理。`)
  }
  return lines.join('\n')
}

export function cueLabel(cue: Cue): string {
  return kindLabel(cue)
}
