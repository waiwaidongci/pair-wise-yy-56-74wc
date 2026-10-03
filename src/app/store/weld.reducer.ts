import { createReducer, on } from '@ngrx/store'
import type { AuditEvent, InspectionPlan, Weld } from '../types'
import type { SchedulingState } from '../core/scheduling'
import { emptyScheduling } from '../core/scheduling-seed'
import { upgradeLegacyPlans } from '../core/scheduling'
import * as A from './weld.actions'

export interface WeldState {
  welds: Weld[]
  plans: InspectionPlan[]
  selectedId: string
  statusFilter: string
  locked: boolean
  version: number
  audit: AuditEvent[]
  /** 设备台账 + 检验员资格 + 检测计划接成的排程批次状态 */
  scheduling: SchedulingState | null
  /** 最近一次提交/换版/恢复/锁定反馈，含占用来源与失败原因 */
  notice: string
}

const nowHHmm = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })

function auditEvent(actor: string, action: string, target: string, detail: string): AuditEvent {
  return { id: `AE-${Date.now()}-${Math.round(Math.random() * 1000)}`, time: nowHHmm(), actor, action, target, detail }
}

const audit: AuditEvent[] = [
  { id: 'AE-1', time: '16:38', actor: '赵岚', action: '提交复检', target: 'W-104', detail: '返修后 UT 复检合格，等待审核签字' },
  { id: 'AE-2', time: '15:12', actor: '陈锋', action: '录入缺陷', target: 'W-107', detail: '翼缘板端部夹渣，长度 12mm，Ⅱ级' },
  { id: 'AE-3', time: '14:20', actor: '系统', action: '资质预警', target: 'W-109', detail: '焊工证书 2026-10-01 到期，不得列入后续检测计划' },
]

export const initialState: WeldState = {
  welds: [], plans: [], selectedId: '', statusFilter: '全部', locked: false, version: 12, audit,
  scheduling: null, notice: '',
}

export const weldReducer = createReducer(
  initialState,
  on(A.loadWeldsSuccess, (state, { welds, plans }) => ({ ...state, welds, plans, selectedId: state.selectedId || welds[0]?.id || '' })),
  on(A.selectWeld, (state, { id }) => ({ ...state, selectedId: id })),
  on(A.filterStatus, (state, { status }) => ({ ...state, statusFilter: status })),
  on(A.advanceWeld, (state, { id, status }) => ({ ...state, version: state.version + 1, welds: state.welds.map((weld) => weld.id === id ? { ...weld, status } : weld), audit: [auditEvent('当前审核人', '状态流转', id, `状态变更为 ${status}`), ...state.audit] })),
  on(A.createPlan, (state, { plan }) => ({ ...state, plans: [plan, ...state.plans], version: state.version + 1 })),

  // 旧计划缺设备或资格版本：不丢弃、不假装可执行，先兼容升级为待补录；原焊缝结果仍可查
  on(A.initScheduling, (state, { legacyPlans, retiredResults = [] }) => {
    if (state.scheduling) return state
    const { state: scheduling, batch } = upgradeLegacyPlans(
      legacyPlans, emptyScheduling(), { now: new Date().toISOString(), seq: () => 1 }, retiredResults,
    )
    return {
      ...state, scheduling,
      notice: `${legacyPlans.length} 个旧计划缺少设备或资格版本，已接入批次 ${batch.id} 并标记待补录；原焊缝结果保留可查`,
      audit: [auditEvent('系统', '兼容升级', batch.id, `${legacyPlans.length} 个旧计划升级为待补录，历史检测结果不迁移、不覆盖`), ...state.audit],
    }
  }),

  // 排程域所有变更（占用 / 换版退回 / WAL 恢复 / 补录 / 锁定）由门面算好后一次性提交
  on(A.schedulingApplied, (state, { scheduling, notice, locked, audit: info }) => ({
    ...state,
    scheduling,
    notice,
    locked: locked ?? state.locked,
    version: state.version + 1,
    audit: [auditEvent(info.actor, info.action, info.target, info.detail), ...state.audit],
  })),

  on(A.lockBaseline, (state) => ({ ...state, locked: true, audit: [auditEvent('质量负责人', '签字锁定', '检测批次', '焊工资质、检测比例与返修闭环已确认'), ...state.audit] })),
)
