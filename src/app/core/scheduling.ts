import type {
  BatchState, CertRef, DaySlot, Equipment, InspectionPlan, Inspector,
  MissingBasisItem, OccupancySource, PlanBasis, PlanState, RetiredResultRef,
  ScheduleBatch, WriteJournalEntry,
} from '../types'

/* ------------------------------------------------------------------ */
/* 时段                                                                */
/* ------------------------------------------------------------------ */

export const SLOT_ORDER: DaySlot[] = ['上午', '下午', '夜间']

export function sameSlot(a: { date: string; slot?: DaySlot }, b: { date: string; slot?: DaySlot }): boolean {
  return a.date === b.date && !!a.slot && a.slot === b.slot
}

/* ------------------------------------------------------------------ */
/* 证书：按方法、日期挑出当日有效的最新换版证书                          */
/* ------------------------------------------------------------------ */

export function validCertOn(
  rows: Array<{ method?: string; certNo: string; validFrom: string; validUntil: string }>,
  method: string,
  date: string,
  forMethod?: string,
): CertRef | undefined {
  return rows
    .filter((row) => (!row.method || row.method === (forMethod ?? method)))
    .filter((row) => row.validFrom <= date && date <= row.validUntil)
    .sort((x, y) => (y.validFrom === x.validFrom ? y.certNo.localeCompare(x.certNo) : y.validFrom.localeCompare(x.validFrom)))[0]
}

export function inspectorCertOn(inspector: Inspector, method: string, date: string): CertRef | undefined {
  return validCertOn(inspector.certs, method, date)
}

export function equipmentCertOn(equipment: Equipment, method: string, date: string): CertRef | undefined {
  if (!equipment.methods.includes(method)) return undefined
  return validCertOn(equipment.calibrations, method, date)
}

/* ------------------------------------------------------------------ */
/* 排程状态                                                            */
/* ------------------------------------------------------------------ */

export interface SchedulingState {
  equipment: Equipment[]
  inspectors: Inspector[]
  batches: ScheduleBatch[]
  plans: InspectionPlan[]
  retiredResults: RetiredResultRef[]
  journal: WriteJournalEntry[]
  /** 已应用日志的排程号集合，重放靠它去重，绝不重复占用 */
  appliedScheduleNos: string[]
  lock?: { lockedAt: string; lockedBy: string; batchIds: string[] }
}

export interface SchedulingContext {
  now: string
  /** 模拟两名调度员先后提交：序号小者先占 */
  seq: () => number
  scheduleNo: () => string
}

export type Result<T> = { ok: true; value: T } | { ok: false; errors: string[] }

/* ------------------------------------------------------------------ */
/* 占用：只统计“会真正到场”的计划（待执行/执行中/已完成）                 */
/* ------------------------------------------------------------------ */

const ACTIVE_STATES: PlanState[] = ['待执行', '执行中', '已完成']

export function isActive(plan: InspectionPlan): boolean {
  return ACTIVE_STATES.includes(plan.state) && !!plan.slot && !!plan.basis
}

/** 列出某计划占用的资源（一台设备 + 一名人员） */
export function occupiedResources(plan: InspectionPlan): Array<{ kind: '设备' | '人员'; id: string }> {
  if (!isActive(plan) || !plan.basis) return []
  return [
    { kind: '设备', id: plan.basis.equipmentId },
    { kind: '人员', id: plan.basis.inspectorId },
  ]
}

/**
 * 冲突判定：同一日期 + 同一时段，设备或检验员已被一笔先到的活动计划占用。
 * 返回占用来源，让后到的调度员看清楚被谁占了。
 */
export function findConflicts(
  draft: { date: string; slot: DaySlot; equipmentId: string; inspectorId: string },
  state: SchedulingState,
  ignorePlanId = '',
): OccupancySource[] {
  const conflicts: OccupancySource[] = []
  for (const plan of state.plans) {
    if (!isActive(plan) || plan.id === ignorePlanId || !plan.basis || !sameSlot(plan, draft)) continue
    const owner = plan.id
    const batchId = plan.batchId ?? ''
    if (plan.basis.equipmentId === draft.equipmentId) {
      conflicts.push({ planId: plan.id, batchId, date: plan.date, slot: plan.slot!, kind: '设备', resourceId: plan.basis.equipmentId, resourceName: plan.basis.equipmentName, owner })
    }
    if (plan.basis.inspectorId === draft.inspectorId) {
      conflicts.push({ planId: plan.id, batchId, date: plan.date, slot: plan.slot!, kind: '人员', resourceId: plan.basis.inspectorId, resourceName: plan.basis.inspectorName, owner })
    }
  }
  return conflicts
}

/* ------------------------------------------------------------------ */
/* 依据检查：锁定前每项计划必须有可用设备和人员依据                       */
/* ------------------------------------------------------------------ */

export interface BasisCheck {
  ok: boolean
  basis?: PlanBasis
  missing: MissingBasisItem[]
}

/** 按方法、日期为一项计划解析当前可用的设备与人员证书依据 */
export function resolveBasis(
  draft: { method: string; date: string; equipmentId: string; inspectorId: string },
  state: SchedulingState,
): BasisCheck {
  const missing: MissingBasisItem[] = []
  const equipment = state.equipment.find((item) => item.id === draft.equipmentId)
  const inspector = state.inspectors.find((item) => item.id === draft.inspectorId)
  let basis: PlanBasis | undefined

  if (!equipment) {
    missing.push({ kind: '设备', detail: `设备 ${draft.equipmentId} 不在台账中` })
  } else if (!equipment.methods.includes(draft.method)) {
    missing.push({ kind: '设备', detail: `${equipment.name} 不支持 ${draft.method} 方法` })
  }
  if (!inspector) {
    missing.push({ kind: '检验员资格', detail: `检验员 ${draft.inspectorId} 不在资格台账中` })
  }

  const equipmentCert = equipment ? equipmentCertOn(equipment, draft.method, draft.date) : undefined
  const inspectorCert = inspector ? inspectorCertOn(inspector, draft.method, draft.date) : undefined
  if (equipment && equipment.methods.includes(draft.method) && !equipmentCert) {
    missing.push({ kind: '设备', detail: `${equipment.name} 的校准证书在 ${draft.date} 无有效版本` })
  }
  if (inspector && !inspectorCert) {
    missing.push({ kind: '检验员资格', detail: `${inspector.name} 无 ${draft.method} 方法在 ${draft.date} 有效的资格版本` })
  }

  if (equipment && inspector && equipmentCert && inspectorCert) {
    basis = {
      equipmentId: equipment.id, equipmentName: equipment.name, equipmentMethod: draft.method, equipmentCert,
      inspectorId: inspector.id, inspectorName: inspector.name, inspectorMethod: draft.method, inspectorCert,
    }
  }
  return { ok: missing.length === 0, basis, missing }
}

/** 已落计划的依据是否仍然成立（证书可能已在执行前换版） */
export function basisStillValid(plan: InspectionPlan, state: SchedulingState): boolean {
  if (!plan.basis || !plan.slot) return false
  const check = resolveBasis({
    method: plan.method, date: plan.date,
    equipmentId: plan.basis.equipmentId, inspectorId: plan.basis.inspectorId,
  }, state)
  if (!check.ok || !check.basis) return false
  // 当前有效证书编号必须与建计划时锁定的版本一致，否则视为换版
  return check.basis.equipmentCert.certNo === plan.basis.equipmentCert.certNo
      && check.basis.inspectorCert.certNo === plan.basis.inspectorCert.certNo
}

/* ------------------------------------------------------------------ */
/* 提交批次：先校验依据，再以“先到先得”预占设备与人员                     */
/* ------------------------------------------------------------------ */

export interface BatchDraftItem {
  /** 由调度员指定，用于重放/失败恢复；正常为空则自动生成 */
  planId?: string
  date: string
  slot: DaySlot
  method: string
  weldIds: string[]
  equipmentId: string
  inspectorId: string
}

export interface SubmitBatchInput {
  batchId?: string
  createdBy: string
  items: BatchDraftItem[]
}

export interface SubmitBatchOutcome {
  batch: ScheduleBatch
  plans: InspectionPlan[]
  /** 被占用而未放行的条目，后到者可看到占用来源 */
  rejected: Array<{ item: BatchDraftItem; index: number; reasons: string[]; conflicts: OccupancySource[] }>
}

export function submitBatch(
  prev: SchedulingState,
  input: SubmitBatchInput,
  ctx: SchedulingContext,
): Result<SubmitBatchOutcome> {
  const errors: string[] = []
  if (input.items.length === 0) errors.push('批次至少包含一项计划')
  for (const [index, item] of input.items.entries()) {
    if (!item.method || !item.date || !item.slot) errors.push(`第 ${index + 1} 项缺少方法、日期或时段`)
    if (item.weldIds.length === 0) errors.push(`第 ${index + 1} 项没有焊缝`)
  }
  if (errors.length) return { ok: false, errors }

  const state: SchedulingState = structuredClone(prev)
  const accepted: InspectionPlan[] = []
  const rejected: SubmitBatchOutcome['rejected'] = []

  // 同一批次内部也按时段占用，后一条撞上先一条同样拒绝
  for (let index = 0; index < input.items.length; index++) {
    const item = input.items[index]!
    const reasons: string[] = []
    const check = resolveBasis(item, state)
    if (!check.ok || !check.basis) reasons.push(...check.missing.map((m) => m.detail))
    const conflicts = findConflicts(item, state)
    if (conflicts.length) reasons.push(...conflicts.map((c) => `${c.date} ${c.slot} ${c.kind}「${c.resourceName}」已被计划 ${c.planId}（批次 ${c.batchId}）占用`))

    if (reasons.length) {
      rejected.push({ item, index, reasons, conflicts })
      continue
    }

    const planId = item.planId ?? `SP-${state.plans.length + 1}-${ctx.seq().toString().padStart(3, '0')}`
    if (state.plans.some((plan) => plan.id === planId)) {
      rejected.push({ item, index, reasons: [`计划号 ${planId} 已存在`], conflicts: [] })
      continue
    }
    const plan: InspectionPlan = {
      id: planId, date: item.date, slot: item.slot, method: item.method,
      weldIds: [...item.weldIds], inspector: check.basis!.inspectorName,
      state: '待执行', basis: check.basis,
    }
    state.plans.push(plan)
    accepted.push(plan)
  }

  if (accepted.length === 0) {
    return { ok: false, errors: rejected.flatMap((r) => r.reasons) }
  }

  const batch: ScheduleBatch = {
    id: input.batchId ?? `SB-${ctx.seq().toString().padStart(4, '0')}`,
    createdAt: ctx.now, createdBy: input.createdBy, state: '待锁定', planIds: accepted.map((p) => p.id),
  }
  if (state.batches.some((b) => b.id === batch.id)) return { ok: false, errors: [`批次号 ${batch.id} 已存在`] }
  for (const plan of accepted) plan.batchId = batch.id
  state.batches.push(batch)

  return { ok: true, value: { batch, plans: accepted, rejected } }
}

/**
 * 带 WAL 的提交：先写“待应用”日志再改状态。
 * 写入失败（applied=false）后可用同一排程号恢复；重复重放不会二次占用。
 */
export function submitBatchJournaled(
  state: SchedulingState,
  input: SubmitBatchInput & { scheduleNo?: string },
  ctx: SchedulingContext,
): { state: SchedulingState; outcome: Result<SubmitBatchOutcome>; entry: WriteJournalEntry } {
  const scheduleNo = input.scheduleNo ?? ctx.scheduleNo()
  const existing = state.journal.find((entry) => entry.scheduleNo === scheduleNo)
  if (existing?.applied) {
    // 幂等：同一排程号重放，直接回放首次结果，不再占用
    return { state, outcome: { ok: false, errors: [`排程号 ${scheduleNo} 已应用，重放被忽略（不重复占用）`] }, entry: existing }
  }

  const entry: WriteJournalEntry = {
    seq: ctx.seq(), scheduleNo, op: '提交批次', time: ctx.now, applied: false,
    payload: { batchId: input.batchId, createdBy: input.createdBy, items: input.items },
  }
  const result = submitBatch(state, input, ctx)
  if (!result.ok) {
    return { state: { ...state, journal: [...state.journal, entry] }, outcome: result, entry }
  }
  const appliedEntry = { ...entry, applied: true }
  const next: SchedulingState = {
    ...state,
    batches: [...state.batches, result.value.batch],
    plans: mergePlans(state.plans, result.value.plans),
    journal: upsertJournal(state.journal, appliedEntry),
    appliedScheduleNos: [...state.appliedScheduleNos, scheduleNo],
  }
  return { state: next, outcome: result, entry: appliedEntry }
}

/* ------------------------------------------------------------------ */
/* 证书换版：计划执行前任何设备校准/人员资格换版，命中的计划退回重排      */
/* ------------------------------------------------------------------ */

export interface RecertInput {
  kind: '设备' | '检验员资格'
  resourceId: string
  method: string
  /** 新证书版本 */
  cert: CertRef
  actor: string
}

export interface RecertOutcome {
  /** 被退回重排的计划 */
  reworked: InspectionPlan[]
  /** 同批次中未受影响、予以保留的计划 */
  untouched: InspectionPlan[]
}

export function applyRecert(
  state: SchedulingState,
  input: RecertInput,
  ctx: SchedulingContext,
): { state: SchedulingState; outcome: RecertOutcome } {
  const equipment = input.kind === '设备' ? state.equipment.find((e) => e.id === input.resourceId) : undefined
  const inspector = input.kind === '检验员资格' ? state.inspectors.find((i) => i.id === input.resourceId) : undefined
  if (input.kind === '设备' && !equipment) throw new Error(`设备 ${input.resourceId} 不存在`)
  if (input.kind === '检验员资格' && !inspector) throw new Error(`检验员 ${input.resourceId} 不存在`)

  let equipment2 = state.equipment
  let inspectors2 = state.inspectors
  if (equipment) {
    equipment2 = state.equipment.map((e) => e.id === input.resourceId
      ? { ...e, calibrations: [...e.calibrations.filter((c) => c.certNo !== input.cert.certNo), { ...input.cert }] }
      : e)
  }
  if (inspector) {
    inspectors2 = state.inspectors.map((i) => i.id === input.resourceId
      ? { ...i, certs: [...i.certs.filter((c) => !(c.method === input.method && c.certNo === input.cert.certNo)), { method: input.method, ...input.cert }] }
      : i)
  }

  const stateWithCert: SchedulingState = { ...state, equipment: equipment2, inspectors: inspectors2 }
  const reworked: InspectionPlan[] = []
  const touchedBatches = new Set<string>()

  const plans2 = stateWithCert.plans.map((plan) => {
    if (plan.state !== '待执行' && plan.state !== '执行中') return plan
    if (!plan.basis || !plan.slot) return plan
    const hitsResource = input.kind === '设备'
      ? plan.basis.equipmentId === input.resourceId
      : plan.basis.inspectorId === input.resourceId
    if (!hitsResource || plan.method !== input.method) return plan
    if (basisStillValid(plan, stateWithCert)) return plan

    touchedBatches.add(plan.batchId ?? '')
    const reworkReason = `${input.actor} 于 ${ctx.now} 将${input.kind}「${input.kind === '设备' ? plan.basis.equipmentName : plan.basis.inspectorName}」${input.method} 证书换版为 ${input.cert.certNo}，计划须在执行前重排`
    const updated: InspectionPlan = { ...plan, state: '已退回重排', reworkReason }
    reworked.push(updated)
    return updated
  })

  // 未受影响的计划：落在被波及批次里、但本身没退回的活动计划 —— 明确保留
  const untouched = plans2.filter((plan) =>
    touchedBatches.has(plan.batchId ?? '') && isActive(plan),
  )

  return { state: { ...stateWithCert, plans: plans2 }, outcome: { reworked, untouched } }
}

/* ------------------------------------------------------------------ */
/* 旧计划兼容升级：缺设备/资格版本不阻断历史，先升级为待补录              */
/* ------------------------------------------------------------------ */

export interface LegacyPlan {
  id: string
  date: string
  method: string
  weldIds: string[]
  inspector: string
  state?: PlanState
}

export function upgradeLegacyPlans(
  legacy: LegacyPlan[],
  state: SchedulingState,
  ctx: { now: string; seq: () => number },
  retiredResults: RetiredResultRef[] = [],
): { state: SchedulingState; plans: InspectionPlan[]; batch: ScheduleBatch } {
  if (state.plans.length > 0 || state.batches.length > 0) {
    throw new Error('兼容升级只能在空排程上执行一次')
  }
  const batch: ScheduleBatch = {
    id: `SB-LEGACY-${ctx.seq().toString().padStart(3, '0')}`,
    createdAt: ctx.now, createdBy: '系统迁移', state: '待补录',
    note: '旧检测计划缺少设备或资格版本，先兼容升级为待补录；原焊缝结果仍可查',
    planIds: legacy.map((p) => p.id),
  }
  const plans: InspectionPlan[] = legacy.map((plan) => {
    const missing: MissingBasisItem[] = [
      { kind: '设备', detail: '旧计划未记录设备与校准证书版本，需补录' },
      { kind: '检验员资格', detail: `旧计划仅有检测人「${plan.inspector}」，未记录资格证书版本，需补录` },
    ]
    return {
      ...plan,
      state: '待补录',
      slot: undefined,
      basis: undefined,
      batchId: batch.id,
      missing,
    }
  })
  return { state: { ...state, plans, batches: [batch], retiredResults: [...state.retiredResults, ...retiredResults] }, plans, batch }
}

/** 待补录计划补录设备、人员与时段；补录后按现行规则校验与占用 */
export function backfillPlan(
  state: SchedulingState,
  planId: string,
  fill: { date: string; slot: DaySlot; equipmentId: string; inspectorId: string; method?: string },
): Result<{ state: SchedulingState; plan: InspectionPlan }> {
  const plan = state.plans.find((p) => p.id === planId)
  if (!plan) return { ok: false, errors: [`计划 ${planId} 不存在`] }
  if (plan.state !== '待补录') return { ok: false, errors: [`计划 ${planId} 不是待补录状态`] }

  const method = fill.method ?? plan.method
  const check = resolveBasis({ method, date: fill.date, equipmentId: fill.equipmentId, inspectorId: fill.inspectorId }, state)
  if (!check.ok || !check.basis) return { ok: false, errors: check.missing.map((m) => m.detail) }
  const conflicts = findConflicts({ date: fill.date, slot: fill.slot, equipmentId: fill.equipmentId, inspectorId: fill.inspectorId }, state, planId)
  if (conflicts.length) return { ok: false, errors: conflicts.map((c) => `${c.date} ${c.slot} ${c.kind}「${c.resourceName}」已被计划 ${c.planId} 占用`) }

  const updated: InspectionPlan = {
    ...plan, method, date: fill.date, slot: fill.slot, basis: check.basis,
    inspector: check.basis.inspectorName, state: '待执行', missing: undefined,
  }
  const batchId = plan.batchId
  const batches = state.batches.map((b) => b.id === batchId && b.planIds.every((pid) => {
    const target = pid === planId ? updated : state.plans.find((p) => p.id === pid)
    return target && target.state !== '待补录'
  }) ? { ...b, state: '待锁定' as BatchState, note: undefined } : b)

  return { ok: true, value: { state: { ...state, plans: state.plans.map((p) => p.id === planId ? updated : p), batches }, plan: updated } }
}

/* ------------------------------------------------------------------ */
/* 锁定：逐项确认每项计划都有可用设备与人员依据，缺一项整批拒绝           */
/* ------------------------------------------------------------------ */

export function lockBatches(
  state: SchedulingState,
  batchIds: string[],
  actor: string,
  now: string,
): Result<{ state: SchedulingState; lockedBatches: ScheduleBatch[]; lock: NonNullable<SchedulingState['lock']> }> {
  const errors: string[] = []
  const lockedBatches: ScheduleBatch[] = []
  for (const batchId of batchIds) {
    const batch = state.batches.find((b) => b.id === batchId)
    if (!batch) { errors.push(`批次 ${batchId} 不存在`); continue }
    if (batch.state === '已锁定') { errors.push(`批次 ${batchId} 已锁定`); continue }

    // 逐项确认：每项计划都必须有当日有效的设备与人员依据，任一不满足整批拒绝
    let batchOk = true
    for (const planId of batch.planIds) {
      const plan = state.plans.find((p) => p.id === planId)
      if (!plan) { errors.push(`批次 ${batchId} 的计划 ${planId} 找不到`); batchOk = false; continue }
      if (plan.state === '待补录') { errors.push(`计划 ${plan.id} 仍为待补录，缺少设备或资格版本`); batchOk = false }
      if (plan.state === '已退回重排') { errors.push(`计划 ${plan.id} 已因证书换版退回重排：${plan.reworkReason ?? ''}`); batchOk = false }
      if (!plan.basis || !plan.slot) { errors.push(`计划 ${plan.id} 缺少设备/人员依据或开工时段`); batchOk = false }
      else if (!basisStillValid(plan, state)) { errors.push(`计划 ${plan.id} 绑定的证书版本已失效，需重新派单`); batchOk = false }
    }
    if (batchOk) lockedBatches.push({ ...batch, state: '已锁定' })
  }
  if (errors.length) return { ok: false, errors }

  const lockedSet = new Set(lockedBatches.map((b) => b.id))
  const lock = { lockedAt: now, lockedBy: actor, batchIds }
  return {
    ok: true,
    value: {
      state: {
        ...state,
        batches: state.batches.map((b) => lockedSet.has(b.id) ? { ...b, state: '已锁定' as BatchState } : b),
        lock,
      },
      lockedBatches, lock,
    },
  }
}

/* ------------------------------------------------------------------ */
/* 原焊缝结果：旧计划升级/退回后仍可查到来源                              */
/* ------------------------------------------------------------------ */

export function archiveResult(state: SchedulingState, ref: RetiredResultRef): SchedulingState {
  if (state.retiredResults.some((r) => r.resultId === ref.resultId)) return state
  return { ...state, retiredResults: [...state.retiredResults, ref] }
}

export function findResultsByWeld(state: SchedulingState, weldId: string): RetiredResultRef[] {
  return state.retiredResults.filter((ref) => ref.weldId === weldId)
}

/* ------------------------------------------------------------------ */
/* WAL 恢复：按排程号找回未应用日志并重放；重放幂等，不重复占用           */
/* ------------------------------------------------------------------ */

/** 模拟“状态写入失败”：日志已落盘（applied=false），但占用未生效 */
export function crashAfterJournal(state: SchedulingState, entry: WriteJournalEntry): SchedulingState {
  return { ...state, journal: upsertJournal(state.journal, { ...entry, applied: false }) }
}

export function recoverByScheduleNo(
  state: SchedulingState,
  scheduleNo: string,
  ctx: SchedulingContext,
): { state: SchedulingState; recovered: boolean; message: string } {
  const entry = state.journal.find((item) => item.scheduleNo === scheduleNo)
  if (!entry) return { state, recovered: false, message: `未找到排程号 ${scheduleNo} 的写入日志` }
  if (entry.applied || state.appliedScheduleNos.includes(scheduleNo)) {
    return { state, recovered: true, message: `排程号 ${scheduleNo} 已应用，跳过重放（占用不重复）` }
  }
  if (entry.op !== '提交批次') {
    return { state, recovered: false, message: `排程号 ${scheduleNo} 为 ${entry.op}，暂不支持自动恢复` }
  }
  const payload = entry.payload as SubmitBatchInput
  const result = submitBatchJournaled(state, { ...payload, scheduleNo }, ctx)
  if (!result.outcome.ok) {
    return { state: result.state, recovered: false, message: result.outcome.errors.join('；') }
  }
  return { state: result.state, recovered: true, message: `排程号 ${scheduleNo} 恢复完成：批次 ${result.outcome.value.batch.id}，放行 ${result.outcome.value.plans.length} 项计划` }
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function mergePlans(existing: InspectionPlan[], added: InspectionPlan[]): InspectionPlan[] {
  const ids = new Set(added.map((p) => p.id))
  return [...existing.filter((p) => !ids.has(p.id)), ...added]
}

function upsertJournal(journal: WriteJournalEntry[], entry: WriteJournalEntry): WriteJournalEntry[] {
  const rest = journal.filter((item) => item.scheduleNo !== entry.scheduleNo)
  return [...rest, entry].sort((a, b) => a.seq - b.seq)
}
