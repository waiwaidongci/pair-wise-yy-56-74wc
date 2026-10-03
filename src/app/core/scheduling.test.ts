/**
 * 核心排程域可执行验证（node --test，无需额外依赖）。
 * 运行：node --import tsx --test src/app/core/scheduling.test.ts
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyRecert, archiveResult, backfillPlan, basisStillValid, crashAfterJournal,
  findConflicts, findResultsByWeld, lockBatches, recoverByScheduleNo,
  resolveBasis, submitBatch, submitBatchJournaled, upgradeLegacyPlans,
  type SchedulingContext, type SchedulingState,
} from './scheduling.ts'
import { emptyScheduling, resetContext } from './scheduling-seed.ts'
import type { DaySlot } from '../types.ts'

function ctx(): SchedulingContext {
  resetContext(1)
  let n = 0
  return {
    now: '2026-10-02T09:00:00.000Z',
    seq: () => ++n,
    scheduleNo: () => `SCH-TEST-${++n}`,
  }
}

const UT_ITEM = {
  date: '2026-10-08', slot: '上午' as DaySlot, method: 'UT',
  weldIds: ['W-104'], equipmentId: 'EQ-UT-01', inspectorId: 'INSP-陈锋',
}

let state: SchedulingState

beforeEach(() => { state = emptyScheduling() })

test('建计划：按方法/日期/时段锁定设备校准与检验员资格版本作为依据', () => {
  const r = submitBatch(state, { createdBy: '调度员甲', items: [UT_ITEM] }, ctx())
  assert.equal(r.ok, true)
  if (!r.ok) return
  const plan = r.value.plans[0]!
  assert.equal(plan.basis?.equipmentCert.certNo, 'CAL-UT01-2026-03')
  assert.equal(plan.basis?.inspectorCert.certNo, 'UT-Ⅱ-陈锋-2025')
  assert.equal(plan.batchId, r.value.batch.id)
  assert.equal(plan.slot, '上午')
})

test('依据校验：设备不支持该方法 / 当日无有效证书 / 检验员无该方法资格 → 拒绝放行', () => {
  const bad = submitBatch(state, {
    createdBy: '调度员甲',
    items: [{ ...UT_ITEM, date: '2030-01-01' }], // 所有证书都过期
  }, ctx())
  assert.equal(bad.ok, false)
  if (bad.ok) return
  assert.ok(bad.errors.some((e) => e.includes('校准证书')))
  assert.ok(bad.errors.some((e) => e.includes('资格版本')))

  const noMethod = submitBatch(state, {
    createdBy: '调度员甲',
    items: [{ ...UT_ITEM, equipmentId: 'EQ-MT-01' }], // 磁粉机做 UT
  }, ctx())
  assert.equal(noMethod.ok, false)
})

test('并发：两名调度员同时段只放行先到一笔，后到者看到占用来源（设备+人员）', () => {
  const c = ctx()
  const first = submitBatch(state, { batchId: 'SB-FIRST', createdBy: '调度员甲', items: [UT_ITEM] }, c)
  assert.equal(first.ok, true)
  if (!first.ok) return

  const next: SchedulingState = {
    ...state,
    batches: [...state.batches, first.value.batch],
    plans: [...state.plans, ...first.value.plans],
  }

  const conflicts = findConflicts(UT_ITEM, next)
  const kinds = conflicts.map((x) => x.kind).sort()
  assert.deepEqual(kinds, ['人员', '设备'])
  assert.equal(conflicts[0]!.planId, first.value.plans[0]!.id)
  assert.equal(conflicts[0]!.batchId, 'SB-FIRST')
  assert.ok(conflicts[0]!.resourceName.length > 0)

  const second = submitBatch(next, { batchId: 'SB-SECOND', createdBy: '调度员乙', items: [{ ...UT_ITEM, weldIds: ['W-110'] }] }, c)
  assert.equal(second.ok, false) // 全部条目被撞 → 批次不生成
})

test('同批次内换一台设备可并行，跨设备不互斥', () => {
  const c = ctx()
  const a = submitBatch(state, { createdBy: '甲', items: [{ ...UT_ITEM, inspectorId: 'INSP-陈锋', equipmentId: 'EQ-UT-01' }] }, c)
  assert.equal(a.ok, true)
  if (!a.ok) return
  const next: SchedulingState = { ...state, batches: [...state.batches, a.value.batch], plans: [...state.plans, ...a.value.plans] }
  // 另一台 UT 仪 + 另一名 UT 检验员，同时段可以
  const b = submitBatch(next, { createdBy: '乙', items: [{ ...UT_ITEM, equipmentId: 'EQ-UT-02', inspectorId: 'INSP-赵岚', weldIds: ['W-112'] }] }, c)
  assert.equal(b.ok, true)
})

test('证书换版：执行前换版只退回命中计划，同批次未受影响计划保留', () => {
  const c = ctx()
  const r = submitBatch(state, {
    batchId: 'SB-MIX', createdBy: '调度员甲',
    items: [
      UT_ITEM,                                                  // EQ-UT-01 + 陈锋
      { date: '2026-10-08', slot: '下午', method: 'UT', weldIds: ['W-112'], equipmentId: 'EQ-UT-02', inspectorId: 'INSP-赵岚' },
      { date: '2026-10-08', slot: '上午', method: 'MT', weldIds: ['W-107'], equipmentId: 'EQ-MT-01', inspectorId: 'INSP-周琪' },
    ],
  }, c)
  assert.equal(r.ok, true)
  if (!r.ok) return
  let next: SchedulingState = { ...state, batches: [...state.batches, r.value.batch], plans: [...state.plans, ...r.value.plans] }

  // EQ-UT-01 的 UT 校准换版（新证从 10-02 生效，旧证 12-31 仍在区间，但编号已变）
  const out = applyRecert(next, {
    kind: '设备', resourceId: 'EQ-UT-01', method: 'UT',
    cert: { certNo: 'CAL-UT01-2026-10', validFrom: '2026-10-02', validUntil: '2027-10-01' },
    actor: '设备管理员',
  }, c)

  assert.equal(out.outcome.reworked.length, 1)
  assert.equal(out.outcome.reworked[0]!.basis?.equipmentId, 'EQ-UT-01')
  assert.equal(out.outcome.reworked[0]!.state, '已退回重排')
  assert.ok(out.outcome.reworked[0]!.reworkReason?.includes('CAL-UT01-2026-10'))
  // 同批次另外两项未受影响，保留为活动计划
  const untouchedIds = out.outcome.untouched.map((p) => p.id).sort()
  assert.equal(untouchedIds.length, 2)

  // 批次本身保留（没有被整批作废）
  assert.ok(out.state.batches.some((b) => b.id === 'SB-MIX'))
  next = out.state

  // 人员资格换版同样能退回
  const out2 = applyRecert(next, {
    kind: '检验员资格', resourceId: 'INSP-周琪', method: 'MT',
    cert: { certNo: 'MT-Ⅲ-周琪-2026-10', validFrom: '2026-10-02', validUntil: '2030-12-31' },
    actor: '质量管理员',
  }, c)
  assert.equal(out2.outcome.reworked.length, 1)
  assert.equal(out2.outcome.reworked[0]!.basis?.inspectorId, 'INSP-周琪')
})

test('旧计划兼容升级为待补录；补录后回到待执行；原焊缝结果仍可查', () => {
  const c = ctx()
  const up = upgradeLegacyPlans([
    { id: 'IP-OLD-1', date: '2026-09-30', method: 'UT + MT', weldIds: ['W-105', 'W-108'], inspector: '陈锋' },
    { id: 'IP-OLD-2', date: '2026-09-29', method: 'UT', weldIds: ['W-104'], inspector: '赵岚' },
  ], state, c, [
    { resultId: 'RR-1', planId: 'IP-OLD-1', batchId: '', weldId: 'W-105', method: 'UT', report: 'R-1', outcome: '合格' },
  ])
  assert.equal(up.plans.every((p) => p.state === '待补录'), true)
  assert.equal(up.plans[0]!.missing?.length, 2)
  assert.equal(up.batch.state, '待补录')

  // 历史结果未丢，按焊缝可查
  const s2 = archiveResult(up.state, { resultId: 'RR-2', planId: 'IP-OLD-2', batchId: '', weldId: 'W-104', method: 'UT', report: 'R-2', outcome: '待复检' })
  assert.equal(findResultsByWeld(s2, 'W-105').length, 1)
  assert.equal(findResultsByWeld(s2, 'W-104')[0]!.report, 'R-2')

  // 待补录不能锁定
  const locked = lockBatches(s2, [up.batch.id], '质量负责人', c.now)
  assert.equal(locked.ok, false)

  // 组合方法 UT+MT 补录时拆成持证单一方法
  const bf = backfillPlan(s2, 'IP-OLD-1', { date: '2026-10-10', slot: '上午', equipmentId: 'EQ-UT-01', inspectorId: 'INSP-陈锋', method: 'UT' })
  assert.equal(bf.ok, true)
  if (!bf.ok) return
  assert.equal(bf.value.plan.state, '待执行')
  assert.equal(bf.value.plan.method, 'UT')
})

test('锁定：每项计划都有当日可用设备与人员依据才放行；换版后未重排则拒绝', () => {
  const c = ctx()
  const r = submitBatch(state, { batchId: 'SB-L1', createdBy: '甲', items: [UT_ITEM] }, c)
  assert.equal(r.ok, true)
  if (!r.ok) return
  let next: SchedulingState = { ...state, batches: [...state.batches, r.value.batch], plans: [...state.plans, ...r.value.plans] }

  const locked = lockBatches(next, ['SB-L1'], '质量负责人', c.now)
  assert.equal(locked.ok, true)
  if (!locked.ok) return
  assert.equal(locked.value.lockedBatches[0]!.state, '已锁定')
  next = locked.value.state

  // 锁定后证书再换版：原锁定计划被退回重排（仍满足“执行前换版拦截”语义，锁定批次历史保留）
  const out = applyRecert(next, {
    kind: '设备', resourceId: 'EQ-UT-01', method: 'UT',
    cert: { certNo: 'CAL-UT01-2026-11', validFrom: '2026-10-03', validUntil: '2027-10-01' },
    actor: '设备管理员',
  }, c)
  assert.equal(out.outcome.reworked.length, 1)
  assert.equal(basisStillValid(out.outcome.reworked[0]!, out.state), false)
})

test('WAL：写入失败后按排程号恢复；重复重放幂等、不重复占用', () => {
  const c = ctx()
  const scheduleNo = 'SCH-RECOVER-X'

  // 1) journal 先落 applied=false，模拟状态写入崩溃
  const crashed = crashAfterJournal(state, {
    seq: 1, scheduleNo, op: '提交批次', time: c.now, applied: false,
    payload: { createdBy: '调度员甲', items: [{ ...UT_ITEM, equipmentId: 'EQ-UT-02', inspectorId: 'INSP-赵岚' }] },
  })
  assert.equal(crashed.plans.length, 0) // 占用未生效

  // 2) 按排程号恢复 → 放行并占用
  const rec1 = recoverByScheduleNo(crashed, scheduleNo, c)
  assert.equal(rec1.recovered, true)
  assert.equal(rec1.state.plans.length, 1)
  assert.equal(rec1.state.journal.find((j) => j.scheduleNo === scheduleNo)?.applied, true)

  // 3) 再恢复一次：幂等，不新增计划、不重复占用
  const rec2 = recoverByScheduleNo(rec1.state, scheduleNo, c)
  assert.equal(rec2.recovered, true)
  assert.ok(rec2.message.includes('跳过重放'))
  assert.equal(rec2.state.plans.length, 1)
  assert.equal(rec2.state.batches.length, 1)
})

test('带 WAL 的提交器：同排程号重放直接拒绝，不二次占用', () => {
  const c = ctx()
  const payload = { createdBy: '调度员甲', items: [UT_ITEM] }
  const first = submitBatchJournaled(state, { ...payload, scheduleNo: 'SCH-IDEM' }, c)
  assert.equal(first.outcome.ok, true)
  assert.equal(first.state.appliedScheduleNos.includes('SCH-IDEM'), true)

  const second = submitBatchJournaled(first.state, { ...payload, scheduleNo: 'SCH-IDEM' }, c)
  assert.equal(second.outcome.ok, false)
  if (second.outcome.ok) return
  assert.ok(second.outcome.errors[0]?.includes('不重复占用'))
  assert.equal(second.state.plans.length, first.state.plans.length)
})

test('退回重排后的时段释放，可重新派单给新计划', () => {
  const c = ctx()
  const r = submitBatch(state, { batchId: 'SB-RW', createdBy: '甲', items: [UT_ITEM] }, c)
  assert.ok(r.ok)
  if (!r.ok) return
  let next: SchedulingState = { ...state, batches: [...state.batches, r.value.batch], plans: [...state.plans, ...r.value.plans] }
  const out = applyRecert(next, {
    kind: '设备', resourceId: 'EQ-UT-01', method: 'UT',
    cert: { certNo: 'CAL-UT01-NEW', validFrom: '2026-10-02', validUntil: '2027-10-01' }, actor: '管理员',
  }, c)
  next = out.state
  // 原时段已无设备/人员占用（退回计划不再占资源）
  assert.equal(findConflicts(UT_ITEM, next).length, 0)
  // 用新证书依据重新派单可成功
  const replan = submitBatch(next, { createdBy: '甲', items: [UT_ITEM] }, c)
  assert.equal(replan.ok, true)
})

test('锁定：多批次同锁时一个不合规即整体拒绝；合规批次可单独锁定', () => {
  const c = ctx()
  const r1 = submitBatch(state, { batchId: 'SB-GOOD', createdBy: '甲', items: [UT_ITEM] }, c)
  assert.ok(r1.ok)
  if (!r1.ok) return
  const s1: SchedulingState = { ...state, batches: [...state.batches, r1.value.batch], plans: [...state.plans, ...r1.value.plans] }
  const r2 = submitBatch(s1, {
    batchId: 'SB-BAD', createdBy: '乙',
    items: [{ date: '2026-10-08', slot: '下午', method: 'UT', weldIds: ['W-112'], equipmentId: 'EQ-UT-02', inspectorId: 'INSP-赵岚' }],
  }, c)
  assert.ok(r2.ok)
  if (!r2.ok) return
  let s2: SchedulingState = { ...s1, batches: [...s1.batches, r2.value.batch], plans: [...s1.plans, ...r2.value.plans] }

  // 让 SB-BAD 的设备证书换版 → 其计划退回
  const rec = applyRecert(s2, {
    kind: '设备', resourceId: 'EQ-UT-02', method: 'UT',
    cert: { certNo: 'CAL-UT02-2026-10', validFrom: '2026-10-02', validUntil: '2027-10-01' }, actor: '管理员',
  }, c)
  s2 = rec.state

  const both = lockBatches(s2, ['SB-GOOD', 'SB-BAD'], '质量负责人', c.now)
  assert.equal(both.ok, false)
  // 全部不锁定（含本来合规的 SB-GOOD），状态保持待锁定
  assert.equal(s2.batches.find((b) => b.id === 'SB-GOOD')!.state, '待锁定')

  const only = lockBatches(s2, ['SB-GOOD'], '质量负责人', c.now)
  assert.equal(only.ok, true)
})

test('resolveBasis 直接返回缺失项明细，供锁定前逐项确认', () => {
  const ok = resolveBasis({ method: 'UT', date: '2026-10-08', equipmentId: 'EQ-UT-01', inspectorId: 'INSP-陈锋' }, state)
  assert.equal(ok.ok, true)
  const bad = resolveBasis({ method: 'PT', date: '2026-10-08', equipmentId: 'EQ-UT-01', inspectorId: 'INSP-陈锋' }, state)
  assert.equal(bad.ok, false)
  assert.ok(bad.missing.some((m) => m.kind === '设备'))
  assert.ok(bad.missing.some((m) => m.kind === '检验员资格'))
})
