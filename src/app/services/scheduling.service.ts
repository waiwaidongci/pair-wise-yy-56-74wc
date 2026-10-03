import { inject, Injectable } from '@angular/core'
import { Store } from '@ngrx/store'
import { filter, first } from 'rxjs'
import type { DaySlot, InspectionPlan, OccupancySource, ScheduleBatch } from '../types'
import {
  applyRecert, backfillPlan, basisStillValid, findConflicts, lockBatches, resolveBasis,
  type RecertInput, recoverByScheduleNo, type SchedulingState,
  submitBatchJournaled, type SubmitBatchInput,
} from '../core/scheduling'
import { defaultContext } from '../core/scheduling-seed'
import { WeldState } from '../store/weld.reducer'
import * as A from '../store/weld.actions'

export interface SubmitFeedback {
  ok: boolean
  batch?: ScheduleBatch
  accepted: InspectionPlan[]
  rejected: Array<{ reasons: string[]; conflicts: OccupancySource[] }>
  errors: string[]
  scheduleNo: string
}

/**
 * 排程门面：所有“占用 / 换版退回 / WAL 恢复 / 补录 / 锁定”都先经核心纯函数算出
 * 下一状态，再用 schedulingApplied 一次性写回 store，避免多次 dispatch 竞态。
 */
@Injectable({ providedIn: 'root' })
export class SchedulingService {
  private readonly store = inject(Store<{ welds: WeldState }>)

  private snapshot(): Promise<SchedulingState> {
    return new Promise((resolve) => {
      this.store.select('welds').pipe(filter((s) => !!s.scheduling), first()).subscribe((s) => resolve(s.scheduling!))
    })
  }

  async submit(input: SubmitBatchInput & { scheduleNo?: string }): Promise<SubmitFeedback> {
    const prev = await this.snapshot()
    const ctx = defaultContext()
    const scheduleNo = input.scheduleNo ?? ctx.scheduleNo()
    const result = submitBatchJournaled(prev, { ...input, scheduleNo }, ctx)
    if (!result.outcome.ok) {
      // 即使失败也落 WAL（applied=false），供按排程号恢复
      this.store.dispatch(A.schedulingApplied({
        scheduling: result.state,
        notice: `排程号 ${scheduleNo} 未放行：${result.outcome.errors.join('；')}`,
        audit: { actor: input.createdBy, action: '提交排程失败', target: scheduleNo, detail: result.outcome.errors.join('；') },
      }))
      return { ok: false, accepted: [], rejected: [], errors: result.outcome.errors, scheduleNo }
    }
    const { batch, plans, rejected } = result.outcome.value
    this.store.dispatch(A.schedulingApplied({
      scheduling: result.state,
      notice: rejected.length
        ? `排程号 ${scheduleNo}：批次 ${batch.id} 放行 ${plans.length} 项；${rejected.length} 项冲突拒收，后到者可见占用来源`
        : `排程号 ${scheduleNo}：批次 ${batch.id} 已按先到先得放行 ${plans.length} 项`,
      audit: { actor: input.createdBy, action: '提交排程', target: batch.id, detail: `排程号 ${scheduleNo}，放行 ${plans.length} 项${rejected.length ? `，冲突拒收 ${rejected.length} 项` : ''}` },
    }))
    return { ok: true, batch, accepted: plans, rejected, errors: [], scheduleNo }
  }

  /** 按排程号恢复未完成的写入；已应用则幂等跳过，绝不重复占用 */
  async recover(scheduleNo: string): Promise<string> {
    const prev = await this.snapshot()
    const result = recoverByScheduleNo(prev, scheduleNo, defaultContext())
    this.store.dispatch(A.schedulingApplied({
      scheduling: result.state,
      notice: result.message,
      audit: { actor: '系统', action: '写入恢复', target: scheduleNo, detail: result.message },
    }))
    return result.message
  }

  /** 设备校准证 / 检验员资格证换版：执行前命中的计划退回重排，其余保留 */
  async recert(input: RecertInput): Promise<{ reworked: InspectionPlan[]; untouched: InspectionPlan[] }> {
    const prev = await this.snapshot()
    const result = applyRecert(prev, input, defaultContext())
    this.store.dispatch(A.schedulingApplied({
      scheduling: result.state,
      notice: result.outcome.reworked.length
        ? `${input.kind}换版 ${input.cert.certNo}：${result.outcome.reworked.length} 项计划退回重排（${result.outcome.reworked.map((p) => p.id).join('、')}）；未受影响批次保留`
        : `${input.kind}换版 ${input.cert.certNo}：无执行前计划受影响，批次全部保留`,
      audit: { actor: input.actor, action: '证书换版', target: input.resourceId, detail: `${input.method} 换版为 ${input.cert.certNo}，退回 ${result.outcome.reworked.length} 项，保留 ${result.outcome.untouched.length} 项` },
    }))
    return result.outcome
  }

  /** 待补录计划补录设备、人员与时段（旧的组合方法可在此落成单一持证方法） */
  async backfill(planId: string, fill: { date: string; slot: DaySlot; equipmentId: string; inspectorId: string; method?: string }): Promise<string[]> {
    const prev = await this.snapshot()
    const result = backfillPlan(prev, planId, fill)
    if (!result.ok) {
      this.store.dispatch(A.schedulingApplied({
        scheduling: prev,
        notice: `计划 ${planId} 补录失败：${result.errors.join('；')}`,
        audit: { actor: '调度员', action: '补录失败', target: planId, detail: result.errors.join('；') },
      }))
      return result.errors
    }
    this.store.dispatch(A.schedulingApplied({
      scheduling: result.value.state,
      notice: `计划 ${planId} 已补录设备与资格版本，回到待执行`,
      audit: { actor: '调度员', action: '补录依据', target: planId, detail: '补齐设备校准与检验员资格版本后重新占用时段' },
    }))
    return []
  }

  /** 锁定批次：锁定前逐项确认可用设备与人员依据，任一不满足整批拒绝 */
  async lock(batchIds: string[], actor = '质量负责人'): Promise<string[]> {
    const prev = await this.snapshot()
    const now = new Date().toISOString()
    const result = lockBatches(prev, batchIds, actor, now)
    if (!result.ok) {
      this.store.dispatch(A.schedulingApplied({
        scheduling: prev,
        notice: `锁定被拒绝：${result.errors.join('；')}`,
        audit: { actor, action: '锁定拒绝', target: batchIds.join('、'), detail: result.errors.join('；') },
      }))
      return result.errors
    }
    const snapshotCount = result.value.state.plans.filter((p) => p.batchId && batchIds.includes(p.batchId)).length
    this.store.dispatch(A.schedulingApplied({
      scheduling: result.value.state,
      locked: true,
      notice: `批次 ${batchIds.join('、')} 已签字锁定：${snapshotCount} 项计划的设备校准与资格版本逐项留痕`,
      audit: { actor, action: '签字锁定', target: batchIds.join('、'), detail: `锁定前逐项确认设备与人员依据，共 ${snapshotCount} 项` },
    }))
    return []
  }

  /** 锁定前自检：每项计划是否都有当日有效的设备与人员证书依据 */
  preLockCheck(state: SchedulingState, batchIds: string[]): { planId: string; ok: boolean; reasons: string[] }[] {
    return state.plans
      .filter((p) => p.batchId && batchIds.includes(p.batchId))
      .map((plan) => {
        const reasons: string[] = []
        if (plan.state === '待补录') reasons.push('待补录：缺少设备或资格版本')
        if (plan.state === '已退回重排') reasons.push(`已退回重排：${plan.reworkReason ?? '证书换版'}`)
        if (!plan.basis || !plan.slot) reasons.push('缺少依据或开工时段')
        else if (!basisStillValid(plan, state)) reasons.push('绑定的证书版本已失效，需重新派单')
        return { planId: plan.id, ok: reasons.length === 0, reasons }
      })
  }

  conflictsOf(state: SchedulingState, draft: { date: string; slot: DaySlot; equipmentId: string; inspectorId: string }) {
    return findConflicts(draft, state)
  }

  resolveBasis(draft: { method: string; date: string; equipmentId: string; inspectorId: string }, state: SchedulingState) {
    return resolveBasis(draft, state)
  }
}
