import { computed, ref, watch } from 'vue'
import { sampleDocument } from './sample'
import { buildSchedule, buildScript, cueDuration, fmtTime, migrateDocument, SCHEDULE_VERSION } from './timeline'
import type {
  Cue,
  CueKind,
  FrozenVersion,
  PendingChange,
  Scene,
  ScheduledItem,
  StudioDocument,
  StudioState,
  TimelineSchedule,
  WarningItem
} from './types'

const STORAGE_KEY = 'sologsb-1016-studio-v1'
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const uid = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`

function loadState(): StudioState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as StudioState
      if (parsed.document?.scenes?.length) {
        // 旧稿没有轨道设置：按顺序兼容补齐通道数与结构版本。
        migrateDocument(parsed.document)
        return parsed
      }
    }
  } catch {
    // A corrupt local draft should not prevent access to the built-in example.
  }
  const document = migrateDocument(clone(sampleDocument))
  return {
    document,
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

  /**
   * 轨道时间表。任何编辑（拖动、改语速、换音效、锁定起点）都会整体重算：
   * 已锁定起点的项目保持不动，其余项目从受影响处向后重排；排不进去的进入冲突清单。
   */
  const schedule = computed<TimelineSchedule>(() =>
    buildSchedule(state.value.document, state.value.document.sfxChannels)
  )

  const itemByCue = computed(() => {
    const map = new Map<string, ScheduledItem>()
    for (const sceneSchedule of schedule.value.scenes) {
      for (const item of sceneSchedule.items) map.set(item.cueId, item)
    }
    return map
  })

  function durationOfCue(cue: Cue): number {
    return cueDuration(cue, state.value.document.soundEffects)
  }

  function durationOfScene(scene: Scene): number {
    // 时间表口径：取所有已排入轨道项目的最晚结束点（拒绝项不计）。
    const sceneSchedule = schedule.value.scenes.find((item) => item.sceneId === scene.id)
    if (sceneSchedule) return sceneSchedule.duration
    return Number(scene.cues.reduce((total, cue) => total + durationOfCue(cue), 0).toFixed(1))
  }

  const totalDuration = computed(() => schedule.value.totalDuration)
  const pendingChanges = computed(() => state.value.pending.filter((item) => item.status === 'pending'))

  const warnings = computed<WarningItem[]>(() => {
    const result: WarningItem[] = []
    const sceneCode = (sceneId: string) =>
      state.value.document.scenes.find((scene) => scene.id === sceneId)?.code ?? ''

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
            detail: `“${cue.text}”引用了不存在的音效 ${cue.soundEffectId}。`
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
    }

    // 排程冲突：同演员区间重叠、主轨溢出、音效通道满载拒绝。
    for (const conflict of schedule.value.conflicts) {
      const code = sceneCode(conflict.sceneId)
      if (conflict.type === 'channel-full') {
        result.push({
          id: `schedule-${conflict.sceneId}-${conflict.cueId}`,
          type: 'channel-full',
          level: 'error',
          sceneId: conflict.sceneId,
          cueId: conflict.cueId,
          title: `${code} 音效通道满载`,
          detail: conflict.detail
        })
      } else if (conflict.type === 'actor-overlap') {
        result.push({
          id: `schedule-actor-${conflict.sceneId}-${conflict.cueIds?.join('-') ?? ''}`,
          type: 'actor-overlap',
          level: 'error',
          sceneId: conflict.sceneId,
          title: `${code} 同演员时间重叠`,
          detail: conflict.detail
        })
      } else {
        result.push({
          id: `schedule-track-${conflict.sceneId}-${conflict.cueId}`,
          type: 'track-overflow',
          level: 'error',
          sceneId: conflict.sceneId,
          cueId: conflict.cueId,
          title: `${code} 主轨排不进去`,
          detail: conflict.detail
        })
      }
    }

    // 场次超限按时间表口径检测。
    for (const sceneSchedule of schedule.value.scenes) {
      const scene = state.value.document.scenes.find((item) => item.id === sceneSchedule.sceneId)
      if (!scene) continue
      if (sceneSchedule.duration > scene.durationLimit) {
        result.push({
          id: `over-${scene.id}`,
          type: 'over-time',
          level: 'warning',
          sceneId: scene.id,
          title: `${scene.code} 超出场次限额`,
          detail: `时间表 ${sceneSchedule.duration.toFixed(1)} 秒，限额 ${scene.durationLimit} 秒，超出 ${(sceneSchedule.duration - scene.durationLimit).toFixed(1)} 秒。`
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
    const document = migrateDocument(clone(next))
    state.value.document = document
    state.value.pending.unshift({
      id: uid('change'),
      label,
      note: '',
      createdAt: new Date().toISOString(),
      status: 'pending',
      before,
      after: clone(document)
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
        else if (field === 'kind') cue.kind = value as CueKind
        else cue[field] = (value ?? '') as never
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
        lockedStart: null
      })
    })
    selectedCueId.value = id
  }

  function deleteCue(cueId: string) {
    commit('删除提示项', (document) => {
      for (const scene of document.scenes) scene.cues = scene.cues.filter((cue) => cue.id !== cueId)
    })
  }

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

  /** 锁定起点：记录当前时间表中的起点；之后的拖动、改语速、换音效只重排其后方项目。 */
  function lockCueStart(cueId: string) {
    const item = itemByCue.value.get(cueId)
    if (!item || item.status === 'rejected') return
    const cue = state.value.document.scenes.flatMap((scene) => scene.cues).find((entry) => entry.id === cueId)
    commit(`锁定${cue?.kind === 'dialogue' ? '台词' : cue?.kind === 'sfx' ? '音效' : '转场'}起点 @${fmtTime(item.start)}`, (document) => {
      for (const scene of document.scenes) {
        const target = scene.cues.find((entry) => entry.id === cueId)
        if (target) {
          target.lockedStart = Number(item.start.toFixed(1))
          return
        }
      }
    })
  }

  function unlockCueStart(cueId: string) {
    commit('解除起点锁定', (document) => {
      for (const scene of document.scenes) {
        const target = scene.cues.find((entry) => entry.id === cueId)
        if (target) {
          target.lockedStart = null
          return
        }
      }
    })
  }

  function isCueLocked(cueId: string): boolean {
    return typeof itemByCue.value.get(cueId)?.locked === 'boolean' && itemByCue.value.get(cueId)?.locked === true
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
    const index = state.value.pending.findIndex((item) => item.id === changeId && item.status === 'pending')
    if (index < 0) return
    const change = state.value.pending[index]
    undoStack.value.push(clone(state.value.document))
    state.value.document = clone(change.before)
    for (let i = 0; i <= index; i += 1) {
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
    const snapshot = schedule.value
    const version: FrozenVersion = {
      id: uid('version'),
      name: name.trim() || `制作稿 v${state.value.frozen.length + 1}`,
      createdAt: new Date().toISOString(),
      document: clone(state.value.document),
      totalDuration: snapshot.totalDuration,
      // 冻结稿自带轨道时间快照，导出时不会随后续编辑漂移。
      schedule: clone(snapshot)
    }
    state.value.frozen.unshift(version)
    persist()
    return version
  }

  function makeScript(document: StudioDocument, snapshot?: TimelineSchedule): string {
    // 冻结稿用快照时间；当前稿或旧稿按顺序兼容补齐后实时排程。
    const resolved = snapshot ?? buildSchedule(document, document.sfxChannels)
    return buildScript(document, resolved)
  }

  function downloadVersion(version: FrozenVersion) {
    const snapshot = version.schedule ?? buildSchedule(version.document, version.document.sfxChannels)
    const blob = new Blob([buildScript(version.document, snapshot)], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${version.document.title}-${version.name}.txt`.replace(/[\\/:*?"<>|]/g, '-')
    anchor.click()
    URL.revokeObjectURL(url)
  }

  function resetSample() {
    commit('恢复示例数据', (document) => {
      const next = migrateDocument(clone(sampleDocument))
      document.title = next.title
      document.subtitle = next.subtitle
      document.targetDuration = next.targetDuration
      document.characters = next.characters
      document.soundEffects = next.soundEffects
      document.scenes = next.scenes
      document.sfxChannels = next.sfxChannels
      document.scheduleVersion = SCHEDULE_VERSION
    })
    selectedSceneId.value = state.value.document.scenes[0]?.id ?? ''
  }

  watch(state, persist, { deep: true })

  return {
    state,
    selectedSceneId,
    selectedCueId,
    selectedScene,
    schedule,
    itemByCue,
    totalDuration,
    pendingChanges,
    warnings,
    saveState,
    durationOfCue,
    durationOfScene,
    updateProject,
    updateScene,
    updateCue,
    addScene,
    deleteScene,
    addCue,
    deleteCue,
    moveCue,
    moveScene,
    lockCueStart,
    unlockCueStart,
    isCueLocked,
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
