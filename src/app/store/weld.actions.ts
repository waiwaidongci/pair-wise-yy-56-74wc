import { createAction, props } from '@ngrx/store'
import type { InspectionPlan, RetiredResultRef, Weld, WeldStatus } from '../types'
import type { SchedulingState } from '../core/scheduling'

export const loadWelds = createAction('[Weld] Load')
export const loadWeldsSuccess = createAction(
  '[Weld API] Load Success',
  props<{ welds: Weld[]; plans: InspectionPlan[]; retiredResults?: RetiredResultRef[] }>(),
)
export const selectWeld = createAction('[Weld] Select', props<{ id: string }>())
export const filterStatus = createAction('[Weld] Filter Status', props<{ status: string }>())
export const advanceWeld = createAction('[Weld] Advance', props<{ id: string; status: WeldStatus }>())
export const createPlan = createAction('[Inspection] Create Plan', props<{ plan: InspectionPlan }>())
export const lockBaseline = createAction('[Approval] Lock Baseline')

/** 旧计划缺设备/资格版本：兼容升级为待补录，原焊缝结果随计划归档仍可查 */
export const initScheduling = createAction(
  '[Scheduling] Init From Legacy Plans',
  props<{ legacyPlans: InspectionPlan[]; retiredResults?: RetiredResultRef[] }>(),
)

/** 排程域下一状态落库（提交占用 / 证书换版退回 / WAL 恢复 / 补录 / 锁定 统一入口） */
export const schedulingApplied = createAction(
  '[Scheduling] Applied',
  props<{
    scheduling: SchedulingState
    notice: string
    locked?: boolean
    audit: { actor: string; action: string; target: string; detail: string }
  }>(),
)
