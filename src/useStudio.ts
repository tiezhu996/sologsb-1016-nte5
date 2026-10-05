import { computed, ref, watch } from 'vue'
import { sampleDocument } from './sample'
import { buildTimetable, cueDuration, formatClock, SFX_TRACKS, TRACK_LABELS } from './scheduler'
import type {
  Cue,
  CueKind,
  CuePlacement,
  FrozenVersion,
  PendingChange,
  Scene,
  StudioDocument,
  StudioState,
  Timetable,
  WarningItem
} from './types'

const STORAGE_KEY = 'sologsb-1016-studio-v1'
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
const round1 = (value: number) => Math.round(value * 10) / 10

/**
 * 旧稿兼容：历史数据没有锁定字段，也没有冻结时间表。
 * 补齐 lockedStart 缺省（undefined 即顺序流式排布），冻结稿的时间表在读取时按需补齐。
 */
function migrateState(parsed: StudioState): StudioState {
  for (const scene of parsed.document?.scenes ?? []) {
    for (const cue of scene.cues ?? []) {
      if (!('lockedStart' in cue)) cue.lockedStart = undefined
    }
  }
  for (const version of parsed.frozen ?? []) {
    for (const scene of version.document?.scenes ?? []) {
      for (const cue of scene.cues ?? []) {
        if (!('lockedStart' in cue)) cue.lockedStart = undefined
      }
    }
    if (!version.timetable) version.timetable = buildTimetable(version.document)
  }
  return parsed
}

function loadState(): StudioState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as StudioState
      if (parsed.document?.scenes?.length) return migrateState(parsed)
    }
  } catch {
    // A corrupt local draft should not prevent access to the built-in example.
  }
  return {
    document: clone(sampleDocument),
    pending: [],
    frozen: [],
    updatedAt: new Date().toISOString()
  }
}

export function useStudio() {
  const state = ref<StudioState>(loadState())
  const selectedSceneId = ref(state.value.document.scenes[0]?.id ?? '')
  const selectedCueId = ref('')
  const saveState = ref<'saved' | 'saving' | 'dirty'>('saved')
  const undoStack = ref<StudioDocument[]>([])
  const redoStack = ref<StudioDocument[]>([])
  let saveTimer: number | undefined

  const selectedScene = computed(() => state.value.document.scenes.find((scene) => scene.id === selectedSceneId.value) ?? state.value.document.scenes[0])

  // 全稿时间表：任意拖动 / 语速 / 音效修改都会整体重算，
  // 但未锁定项只受其位置之后的变化影响（同位置前内容不变时起点不变）。
  const timetable = computed<Timetable>(() => buildTimetable(state.value.document))

  const sceneSchedule = (scene: Scene) =>
    timetable.value.scenes.find((item) => item.sceneId === scene.id)

  function durationOfCue(cue: Cue): number {
    return cueDuration(cue, state.value.document.soundEffects)
  }

  /** 场次跨度 = 主轨末尾与最远音效末尾的较大者；被拒绝的音效不占时长。 */
  function durationOfScene(scene: Scene): number {
    return sceneSchedule(scene)?.span ?? 0
  }

  const totalDuration = computed(() => timetable.value.totalDuration)
  const pendingChanges = computed(() => state.value.pending.filter((item) => item.status === 'pending'))

  function cuePlacement(cueId: string): CuePlacement | undefined {
    for (const schedule of timetable.value.scenes) {
      const hit = schedule.placements.find((item) => item.cueId === cueId)
        ?? schedule.rejected.find((item) => item.cueId === cueId)
      if (hit) return hit
    }
    return undefined
  }

  const warnings = computed<WarningItem[]>(() => {
    const result: WarningItem[] = []
    for (const scene of state.value.document.scenes) {
      const actorRoles = new Map<string, string[]>()
      for (const cue of scene.cues) {
        if (cue.kind === 'dialogue' && cue.characterId) {
          const character = state.value.document.characters.find((item) => item.id === cue.characterId)
          if (character) {
            const roles = actorRoles.get(character.voiceActor) ?? []
            roles.push(character.name)
            actorRoles.set(character.voiceActor, roles)
          }
        }
        if (cue.kind === 'sfx' && cue.soundEffectId && !state.value.document.soundEffects.some((effect) => effect.id === cue.soundEffectId)) {
          result.push({
            id: `missing-${cue.id}`,
            type: 'missing-sfx',
            level: 'error',
            sceneId: scene.id,
            cueId: cue.id,
            title: `${scene.code} 音效引用缺失`,
            detail: `“${cue.text}”引用了不存在的音效 ${cue.soundEffectId}，时间表按 6 秒占位。`
          })
        }
      }
      actorRoles.forEach((roles, actor) => {
        const uniqueRoles = [...new Set(roles)]
        if (uniqueRoles.length > 1) {
          result.push({
            id: `collision-${scene.id}-${actor}`,
            type: 'collision',
            level: 'error',
            sceneId: scene.id,
            title: `${scene.code} 角色撞场`,
            detail: `${actor} 同时为 ${uniqueRoles.join('、')} 配音；同场角色需拆分演员或调整台词。`
          })
        }
      })

      // 时间表冲突：同演员重叠 / 主轨重叠 / 通道容量不足 / 非法锁定点。
      const schedule = sceneSchedule(scene)
      for (const conflict of schedule?.conflicts ?? []) {
        result.push({ id: `schedule-${conflict.type}-${conflict.cueId}`, ...conflict })
      }

      const sceneDuration = durationOfScene(scene)
      if (sceneDuration > scene.durationLimit) {
        result.push({
          id: `over-${scene.id}`,
          type: 'over-time',
          level: 'warning',
          sceneId: scene.id,
          title: `${scene.code} 超出场次限额`,
          detail: `时间表跨度 ${sceneDuration.toFixed(1)} 秒，限额 ${scene.durationLimit} 秒，超出 ${(sceneDuration - scene.durationLimit).toFixed(1)} 秒。`
        })
      }
    }
    return result
  })

  function persist() {
    state.value.updatedAt = new Date().toISOString()
    saveState.value = 'saving'
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.value))
      saveState.value = 'saved'
    }, 180)
  }

  function commit(label: string, mutator: (document: StudioDocument) => void, note = '') {
    const before = clone(state.value.document)
    const document = clone(state.value.document)
    mutator(document)
    undoStack.value.push(before)
    if (undoStack.value.length > 60) undoStack.value.shift()
    redoStack.value = []
    state.value.document = document
    state.value.pending.unshift({
      id: uid('change'),
      label,
      note,
      createdAt: new Date().toISOString(),
      status: 'pending',
      before,
      after: clone(document)
    })
    if (state.value.pending.length > 80) state.value.pending = state.value.pending.slice(0, 80)
    persist()
  }

  function replaceDocument(next: StudioDocument, label: string) {
    const before = clone(state.value.document)
    state.value.document = clone(next)
    state.value.pending.unshift({
      id: uid('change'),
      label,
      note: '',
      createdAt: new Date().toISOString(),
      status: 'pending',
      before,
      after: clone(next)
    })
    persist()
  }

  function updateProject(field: 'title' | 'subtitle' | 'targetDuration', value: string | number) {
    commit(`更新项目${field === 'title' ? '标题' : field === 'subtitle' ? '副标题' : '目标时长'}`, (document) => {
      if (field === 'targetDuration') document.targetDuration = Number(value)
      else document[field] = String(value)
    })
  }

  function updateScene(sceneId: string, field: keyof Scene, value: string | number) {
    commit(`更新 ${state.value.document.scenes.find((scene) => scene.id === sceneId)?.code ?? '场次'} ${field}`, (document) => {
      const scene = document.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      if (field === 'durationLimit') scene.durationLimit = Number(value)
      else if (field === 'code' || field === 'title' || field === 'location' || field === 'timeOfDay' || field === 'transition') scene[field] = String(value)
    })
  }

  function updateCue(cueId: string, field: keyof Cue, value: string | number | undefined) {
    commit(`修改台词 ${state.value.document.scenes.flatMap((scene) => scene.cues).find((cue) => cue.id === cueId)?.text.slice(0, 12) ?? ''}`, (document) => {
      for (const scene of document.scenes) {
        const cue = scene.cues.find((item) => item.id === cueId)
        if (!cue) continue
        if (field === 'rate') cue.rate = Number(value) as Cue['rate']
        else if (field === 'manualDuration') cue.manualDuration = value === '' || value === undefined ? undefined : Number(value)
        else if (field === 'lockedStart') cue.lockedStart = value === '' || value === undefined ? undefined : round1(Number(value))
        else if (field === 'kind') cue.kind = value as CueKind
        else cue[field] = (value ?? '') as never
        break
      }
    })
  }

  /** 锁定起点：未指定时钉住当前时间表算出的（本场相对）起点；再次调用解除。 */
  function toggleCueLock(cueId: string) {
    const current = cuePlacement(cueId)
    const sceneId = state.value.document.scenes.find((scene) => scene.cues.some((cue) => cue.id === cueId))?.id
    const schedule = sceneId ? timetable.value.scenes.find((item) => item.sceneId === sceneId) : undefined
    const relativeStart = current && schedule ? round1(current.start - schedule.start) : 0
    const target = state.value.document.scenes
      .flatMap((scene) => scene.cues)
      .find((cue) => cue.id === cueId)
    commit(target?.lockedStart === undefined ? '锁定提示起点' : '解除起点锁定', (document) => {
      for (const scene of document.scenes) {
        const cue = scene.cues.find((item) => item.id === cueId)
        if (!cue) continue
        cue.lockedStart = cue.lockedStart === undefined ? relativeStart : undefined
        break
      }
    })
  }

  function addScene() {
    const nextNumber = state.value.document.scenes.length + 1
    const id = uid('scene')
    commit(`新增场次 S${String(nextNumber).padStart(2, '0')}`, (document) => {
      document.scenes.push({
        id,
        code: `S${String(nextNumber).padStart(2, '0')}`,
        title: '未命名场次',
        location: '待填写',
        timeOfDay: '待填写',
        transition: '淡入',
        durationLimit: 150,
        cues: []
      })
    })
    selectedSceneId.value = id
  }

  function deleteScene(sceneId: string) {
    if (state.value.document.scenes.length <= 1) return
    const scene = state.value.document.scenes.find((item) => item.id === sceneId)
    commit(`删除场次 ${scene?.code ?? ''}`, (document) => {
      document.scenes = document.scenes.filter((item) => item.id !== sceneId)
    })
    selectedSceneId.value = state.value.document.scenes[0].id
  }

  function addCue(kind: CueKind, sceneId = selectedSceneId.value) {
    const id = uid('cue')
    commit(`新增${kind === 'dialogue' ? '台词' : kind === 'sfx' ? '音效' : '转场'}`, (document) => {
      const scene = document.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      scene.cues.push({
        id,
        kind,
        characterId: kind === 'dialogue' ? document.characters[0]?.id : undefined,
        text: kind === 'dialogue' ? '请输入台词' : kind === 'sfx' ? '音效提示' : '转场说明',
        emotion: kind === 'dialogue' ? '自然' : '',
        rate: 1,
        soundEffectId: kind === 'sfx' ? document.soundEffects[0]?.id : undefined,
        transition: kind === 'transition' ? '淡出' : '',
        manualDuration: kind === 'transition' ? 3 : undefined,
        lockedStart: undefined
      })
    })
    selectedCueId.value = id
  }

  function deleteCue(cueId: string) {
    commit('删除提示项', (document) => {
      for (const scene of document.scenes) scene.cues = scene.cues.filter((cue) => cue.id !== cueId)
    })
  }

  /** 拖动改序：受影响项（落点之后）随下一次时间表计算自动重排，锁定项保持不动。 */
  function moveCue(sceneId: string, cueId: string, targetCueId: string) {
    if (cueId === targetCueId) return
    commit('拖动调整台词与音效顺序', (document) => {
      const scene = document.scenes.find((item) => item.id === sceneId)
      if (!scene) return
      const fromIndex = scene.cues.findIndex((cue) => cue.id === cueId)
      const toIndex = scene.cues.findIndex((cue) => cue.id === targetCueId)
      if (fromIndex < 0 || toIndex < 0) return
      const [moved] = scene.cues.splice(fromIndex, 1)
      scene.cues.splice(toIndex, 0, moved)
    })
  }

  function moveScene(sceneId: string, direction: -1 | 1) {
    const index = state.value.document.scenes.findIndex((scene) => scene.id === sceneId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= state.value.document.scenes.length) return
    commit('调整场次顺序', (document) => {
      const [scene] = document.scenes.splice(index, 1)
      document.scenes.splice(target, 0, scene)
    })
  }

  function acceptChange(changeId: string) {
    const change = state.value.pending.find((item) => item.id === changeId)
    if (!change || change.status !== 'pending') return
    change.status = 'accepted'
    persist()
  }

  function rejectChange(changeId: string) {
    const targetIndex = state.value.pending.findIndex((item) => item.id === changeId && item.status === 'pending')
    if (targetIndex < 0) return
    const change = state.value.pending[targetIndex]
    undoStack.value.push(clone(state.value.document))
    state.value.document = clone(change.before)
    for (let i = 0; i <= targetIndex; i += 1) {
      if (state.value.pending[i].status === 'pending') state.value.pending[i].status = 'rejected'
    }
    persist()
  }

  function acceptAll() {
    for (const change of state.value.pending) {
      if (change.status === 'pending') change.status = 'accepted'
    }
    persist()
  }

  function undo() {
    const previous = undoStack.value.pop()
    if (!previous) return
    redoStack.value.push(clone(state.value.document))
    replaceDocument(previous, '撤销上一步修改')
  }

  function redo() {
    const next = redoStack.value.pop()
    if (!next) return
    undoStack.value.push(clone(state.value.document))
    replaceDocument(next, '重做修改')
  }

  function freeze(name: string): FrozenVersion {
    const version: FrozenVersion = {
      id: uid('version'),
      name: name.trim() || `制作稿 v${state.value.frozen.length + 1}`,
      createdAt: new Date().toISOString(),
      document: clone(state.value.document),
      totalDuration: totalDuration.value,
      timetable: clone(timetable.value)
    }
    state.value.frozen.unshift(version)
    persist()
    return version
  }

  /** 带轨道时间的制作稿文本。旧冻结稿没有时间表时按当前顺序兼容补齐。 */
  function makeScript(document: StudioDocument, frozenTimetable?: Timetable): string {
    const table = frozenTimetable ?? buildTimetable(document)
    const lines = [
      document.title,
      document.subtitle,
      `目标时长：${document.targetDuration} 秒｜时间表总时长：${table.totalDuration.toFixed(1)} 秒`,
      `冲突：${table.conflicts.length} 项｜被拒绝音效：${table.scenes.reduce((total, scene) => total + scene.rejected.length, 0)} 条`,
      '='.repeat(48),
      ''
    ]

    document.scenes.forEach((scene, sceneIndex) => {
      const schedule = table.scenes.find((item) => item.sceneId === scene.id)
      const base = schedule?.start ?? 0
      const placed = schedule?.placements ?? []
      const mainItems = placed.filter((item) => item.track === 'main')
      const sfxByTrack = new Map(SFX_TRACKS.map((track) => [track, placed.filter((item) => item.track === track)]))

      lines.push(`${scene.code}｜${scene.title}`)
      lines.push(`场景：${scene.location} / ${scene.timeOfDay}`)
      lines.push(`转场：${scene.transition}`)
      lines.push(`入场时间：${formatClock(base)}｜场次跨度：${(schedule?.span ?? 0).toFixed(1)} 秒｜限额：${scene.durationLimit} 秒`)
      lines.push('-'.repeat(34))

      for (const placement of mainItems) {
        const cue = scene.cues.find((item) => item.id === placement.cueId)
        if (!cue) continue
        const prefix = `[${formatClock(placement.start)} → ${formatClock(placement.end)}]${placement.locked ? ' 🔒' : ''}`
        if (cue.kind === 'dialogue') {
          const role = document.characters.find((character) => character.id === cue.characterId)?.name ?? '未指定角色'
          lines.push(`${prefix} 主轨 ${role}｜${cue.emotion || '自然'}｜语速 ${cue.rate}`)
          lines.push(`    ${cue.text}`)
        } else {
          lines.push(`${prefix} 主轨 转场｜${cue.transition}｜${cue.text}`)
        }
      }

      for (const track of SFX_TRACKS) {
        for (const placement of sfxByTrack.get(track) ?? []) {
          const cue = scene.cues.find((item) => item.id === placement.cueId)
          if (!cue) continue
          const effect = document.soundEffects.find((item) => item.id === cue.soundEffectId)
          const prefix = `[${formatClock(placement.start)} → ${formatClock(placement.end)}]${placement.locked ? ' 🔒' : ''}`
          lines.push(`${prefix} ${TRACK_LABELS[track]} ${cue.text}`)
          lines.push(`    文件：${effect?.source ?? '缺失引用'}｜${effect?.note ?? '需补齐音效'}`)
        }
      }

      for (const placement of schedule?.rejected ?? []) {
        const cue = scene.cues.find((item) => item.id === placement.cueId)
        lines.push(`[拒绝 @${formatClock(placement.start)}] 音效通道容量不足：${cue?.text ?? placement.cueId}（请求 ${placement.duration.toFixed(1)}s，三条通道均占用）`)
      }

      if (schedule?.conflicts.length) {
        lines.push('—— 排程冲突 ——')
        for (const conflict of schedule.conflicts) {
          lines.push(`✗ ${conflict.title}：${conflict.detail}`)
        }
      }

      if (sceneIndex < document.scenes.length - 1) lines.push('')
    })
    return lines.join('\n')
  }

  function downloadVersion(version: FrozenVersion) {
    const blob = new Blob([makeScript(version.document, version.timetable)], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${version.document.title}-${version.name}.txt`.replace(/[\\/:*?"<>|]/g, '-')
    anchor.click()
    URL.revokeObjectURL(url)
  }

  function resetSample() {
    commit('恢复示例数据', (document) => {
      const next = clone(sampleDocument)
      Object.assign(document, next)
    })
    selectedSceneId.value = state.value.document.scenes[0]?.id ?? ''
  }

  watch(state, persist, { deep: true })

  return {
    state,
    selectedSceneId,
    selectedCueId,
    selectedScene,
    timetable,
    totalDuration,
    pendingChanges,
    warnings,
    saveState,
    durationOfCue,
    durationOfScene,
    cuePlacement,
    sceneSchedule,
    updateProject,
    updateScene,
    updateCue,
    toggleCueLock,
    addScene,
    deleteScene,
    addCue,
    deleteCue,
    moveCue,
    moveScene,
    acceptChange,
    rejectChange,
    acceptAll,
    undo,
    redo,
    freeze,
    downloadVersion,
    makeScript,
    resetSample,
    persist
  }
}
