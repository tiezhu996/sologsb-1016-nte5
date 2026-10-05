import type {
  Cue,
  CuePlacement,
  Scene,
  SceneSchedule,
  ScheduleConflict,
  SoundEffect,
  StudioDocument,
  Timetable,
  TrackId
} from './types'

export const SFX_TRACKS: TrackId[] = ['sfx-1', 'sfx-2', 'sfx-3']
export const TRACK_LABELS: Record<TrackId, string> = {
  main: '主轨 · 台词/转场',
  'sfx-1': '音效 A',
  'sfx-2': '音效 B',
  'sfx-3': '音效 C'
}
export const EPS = 0.05

const round1 = (value: number) => Math.round(value * 10) / 10

/** 提示时长：手动覆盖优先，其次素材时长，缺失音效回退 6 秒，转场默认 3 秒，台词按字数/语速估算。 */
export function cueDuration(cue: Cue, effects: SoundEffect[]): number {
  if (cue.manualDuration !== undefined && cue.manualDuration !== null) return cue.manualDuration
  if (cue.kind === 'sfx') {
    return effects.find((effect) => effect.id === cue.soundEffectId)?.duration ?? 6
  }
  if (cue.kind === 'transition') return 3
  const pauses = (cue.text.match(/[，。！？；、…]/g)?.length ?? 0) * 0.22
  const effectiveRate = cue.rate || 1
  return Number((cue.text.length / (4.2 * effectiveRate) + pauses).toFixed(1))
}

function cueOrdinal(sceneCode: string, index: number) {
  return `${sceneCode}#${index + 1}`
}

export function buildTimetable(document: StudioDocument): Timetable {
  const schedules: SceneSchedule[] = []
  const conflicts: ScheduleConflict[] = []
  let cursor = 0

  for (const scene of document.scenes) {
    const schedule = scheduleScene(scene, cursor, document)
    schedules.push(schedule)
    conflicts.push(...schedule.conflicts)
    cursor = round1(cursor + schedule.span)
  }

  return { scenes: schedules, conflicts, totalDuration: cursor }
}

interface LocalPlacement {
  cueId: string
  kind: Cue['kind']
  track: TrackId | null
  start: number
  end: number
  duration: number
  status: 'placed' | 'rejected'
  locked: boolean
}

/**
 * 单场排布规则：
 * - 台词与转场顺序占用主轨；转场起点接在上一项主轨内容的末尾。
 * - 音效不推进主轨时钟，按场次在 A/B/C 三条通道上先到先得（通道容量 3）。
 * - 未锁定的主轨提示从主时钟流式向后排布；锁定起点的提示保持不动，
 *   后续内容从其末尾继续，与已占用区间重叠时记录冲突（同演员报演员冲突，其余报轨位冲突）。
 * - 锁定音效同样参与通道竞争；放不下即拒绝。通道不足只拒绝当前提示，
 *   后续提示仍按各自起点继续尝试。
 */
function scheduleScene(scene: Scene, sceneStart: number, document: StudioDocument): SceneSchedule {
  const placements: LocalPlacement[] = []
  const rejected: LocalPlacement[] = []
  const conflicts: ScheduleConflict[] = []

  let mainClock = 0
  // 每条音效通道记录占用到的（场景相对）秒数。
  const channelFreeAt = [0, 0, 0]
  let sfxFarthestEnd = 0

  const actorOf = (cue: Cue) =>
    cue.characterId
      ? document.characters.find((character) => character.id === cue.characterId)?.voiceActor
      : undefined

  scene.cues.forEach((cue, index) => {
    const duration = cueDuration(cue, document.soundEffects)
    const ordinal = cueOrdinal(scene.code, index)

    if (cue.kind === 'sfx') {
      const locked = cue.lockedStart !== undefined && cue.lockedStart !== null
      const nominalStart = locked ? (cue.lockedStart as number) : mainClock
      const start = round1(Math.max(0, nominalStart))
      const channel = channelFreeAt.findIndex((freeAt) => start + EPS >= freeAt)

      if (channel < 0) {
        const freeTimes = channelFreeAt.map((time) => time.toFixed(1)).join(' / ')
        rejected.push({
          cueId: cue.id,
          kind: cue.kind,
          track: null,
          start,
          end: round1(start + duration),
          duration,
          status: 'rejected',
          locked
        })
        conflicts.push({
          type: 'channel-full',
          level: 'error',
          sceneId: scene.id,
          cueId: cue.id,
          title: `${scene.code} 音效通道已满`,
          detail: `提示 ${ordinal}“${cue.text}”请求在 ${start.toFixed(1)}s 起播，但本场三条音效通道均被占用（最早释放 ${freeTimes}s），已拒绝；请分批、换通道空闲时段或调整时长。`
        })
        return
      }

      const end = round1(start + duration)
      channelFreeAt[channel] = end
      sfxFarthestEnd = Math.max(sfxFarthestEnd, end)
      placements.push({
        cueId: cue.id,
        kind: cue.kind,
        track: SFX_TRACKS[channel],
        start,
        end,
        duration,
        status: 'placed',
        locked
      })
      return
    }

    const locked = cue.lockedStart !== undefined && cue.lockedStart !== null
    let start: number
    if (locked) {
      start = cue.lockedStart as number
      if (!Number.isFinite(start) || start < 0) {
        conflicts.push({
          type: 'invalid-locked-start',
          level: 'error',
          sceneId: scene.id,
          cueId: cue.id,
          title: `${scene.code} 锁定起点无效`,
          detail: `提示 ${ordinal}“${cue.text}”锁定了无效起点 ${String(cue.lockedStart)}，已按 0s 处理，请重新设置。`
        })
        start = 0
      }
    } else {
      start = mainClock
    }
    start = round1(start)
    const end = round1(start + duration)

    // 与主轨上已经排定的区间比对（锁定项不移动时可能产生重叠）。
    const overlapping = placements.filter(
      (item) => item.track === 'main' && item.start + EPS < end && item.end - EPS > start
    )
    if (overlapping.length) {
      const overlap = round1(Math.min(end, ...overlapping.map((item) => item.end)) - start)
      const actor = actorOf(cue)
      const sameActorHit = cue.kind === 'dialogue' && actor
        ? overlapping.some((item) => {
            if (item.kind !== 'dialogue') return false
            const otherCue = scene.cues.find((target) => target.id === item.cueId)
            return otherCue ? actorOf(otherCue) === actor : false
          })
        : false

      if (sameActorHit) {
        conflicts.push({
          type: 'actor-overlap',
          level: 'error',
          sceneId: scene.id,
          cueId: cue.id,
          title: `${scene.code} 同演员区间重叠`,
          detail: `提示 ${ordinal}（${actor}）锁定在 ${start.toFixed(1)}s，与同演员前序台词重叠约 ${overlap.toFixed(1)}s；锁定项保持不动，请调整前序语速/时长或解除锁定。`
        })
      } else {
        conflicts.push({
          type: 'track-overlap',
          level: 'error',
          sceneId: scene.id,
          cueId: cue.id,
          title: `${scene.code} 主轨时间重叠`,
          detail: `提示 ${ordinal}“${cue.text}”起点 ${start.toFixed(1)}s 与主轨已占用区间重叠约 ${overlap.toFixed(1)}s；锁定项保持不动，请解锁或调整前序内容。`
        })
      }
    }

    placements.push({
      cueId: cue.id,
      kind: cue.kind,
      track: 'main',
      start,
      end,
      duration,
      status: 'placed',
      locked
    })
    mainClock = Math.max(mainClock, end)
  })

  const span = round1(Math.max(mainClock, sfxFarthestEnd))
  const toGlobal = (item: LocalPlacement): CuePlacement => ({
    ...item,
    sceneId: scene.id,
    start: round1(sceneStart + item.start),
    end: round1(sceneStart + item.end)
  })

  return {
    sceneId: scene.id,
    start: sceneStart,
    span,
    placements: placements.filter((item) => item.status === 'placed').map(toGlobal),
    conflicts,
    rejected: rejected.map(toGlobal)
  }
}

/** mm:ss.d，时间表面板与导出共用。 */
export function formatClock(seconds: number): string {
  const safe = Math.max(0, seconds)
  const minutes = Math.floor(safe / 60)
  const rest = safe - minutes * 60
  const whole = Math.floor(rest)
  const tenth = Math.round((rest - whole) * 10)
  return `${String(minutes).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${tenth}`
}
