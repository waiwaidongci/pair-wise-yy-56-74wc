// 排程批次领域模型：设备台账、检验员资格、预占与版本依据

export type Method = 'UT' | 'MT' | 'PT'
export type SlotPeriod = '上午' | '下午'
export type PlanState = '待执行' | '执行中' | '已完成' | '待重排' | '待补录'
export type ReservationState = '有效' | '失效'
export type CertTarget = 'equipment' | 'inspector'

export interface Equipment {
  id: string
  name: string
  method: Method
  calibrationCertNo: string        // 校准证书编号
  calibrationCertVersion: number   // 校准证书版本（换证 +1）
  calibrationValidUntil: string
  status: '可用' | '校准中' | '停用'
}

export interface Inspector {
  id: string
  name: string
  methods: Method[]
  certNo: string                   // 检验员资格证书编号
  certVersion: number              // 资格证书版本（换证 +1）
  certValidUntil: string
}

// 预占记录：建计划时按方法、日期、时段锁定设备与人员，并固化当时证书版本
export interface Reservation {
  id: string
  planId: string
  scheduleNo: string               // 排程号（幂等键，写入失败后按此恢复）
  equipmentId: string
  inspectorId: string
  method: Method
  slotDate: string
  slotPeriod: SlotPeriod
  equipmentCertVersion: number     // 预占时依据的设备校准证书版本
  inspectorCertVersion: number     // 预占时依据的人员资格证书版本
  state: ReservationState
  createdAt: string
}

export interface SchedulePlan {
  id: string
  scheduleNo: string
  date: string
  method: Method
  period: SlotPeriod
  weldIds: string[]
  inspector: string
  inspectorId: string
  state: PlanState
  equipmentId?: string
  equipmentCertVersion?: number
  inspectorCertVersion?: number
  reservationId?: string
  legacy?: boolean                 // 旧计划兼容升级标记
}

export interface ScheduleAudit {
  id: string
  time: string
  actor: string
  action: string
  target: string
  detail: string
}

export interface ScheduleBoard {
  equipment: Equipment[]
  inspectors: Inspector[]
  plans: SchedulePlan[]
  reservations: Reservation[]
  audit: ScheduleAudit[]
  locked: boolean
}

// 后到调度员看到的占用来源
export interface OccupiedBy {
  planId: string
  scheduleNo: string
  resourceType: '设备' | '人员' | '设备与人员'
  resourceLabel: string
}

export interface CreateInput {
  method: Method
  date: string
  period: SlotPeriod
  weldIds: string[]
  inspectorId?: string
  equipmentId?: string
}

export interface RescheduleInput {
  date: string
  period: SlotPeriod
  equipmentId: string
  inspectorId: string
}

export interface ActionResult {
  ok: boolean
  kind: 'create' | 'renew' | 'reschedule' | 'supplement' | 'lock'
  message: string
  scheduleNo?: string
  networkError?: boolean
  replayed?: boolean
  occupiedBy?: OccupiedBy
  affected?: { id: string; scheduleNo: string }[]
  blockers?: { planId: string; scheduleNo: string; reason: string }[]
}
