export type WeldStatus = '待检测' | '合格' | '返修中' | '待复检' | '已关闭'
export type DefectLevel = 'Ⅰ级' | 'Ⅱ级' | 'Ⅲ级' | 'Ⅳ级'

export interface Defect {
  id: string
  position: number
  type: string
  length: number
  level: DefectLevel
  method: string
  report: string
}

export interface Weld {
  id: string
  drawing: string
  component: string
  joint: string
  method: string
  welder: string
  qualification: string
  qualificationValid: boolean
  inspectionRatio: number
  requiredRatio: number
  status: WeldStatus
  x: number
  y: number
  repairs: number
  defects: Defect[]
}

/** 计划执行状态：退回重排不删除批次，受影响计划标记后等待重新派单 */
export type PlanState = '待执行' | '执行中' | '已完成' | '待补录' | '已退回重排'
/** 批次流转状态：旧数据兼容升级后停留在待补录，证书换版只影响命中的计划，批次保留 */
export type BatchState = '待补录' | '待锁定' | '已锁定'

export interface InspectionPlan {
  id: string
  date: string
  method: string
  weldIds: string[]
  inspector: string
  state: PlanState
  /** 升级后的计划所属排程批次；旧数据兼容升级时由系统回填 */
  batchId?: string
  /** 具体开工时段，设备与人员按时段预占 */
  slot?: DaySlot
  /** 建计划时锁定的设备与人员证书依据；待补录计划为空，锁定前必须补齐 */
  basis?: PlanBasis
  /** 退回重排的原因（哪台设备 / 哪位检验员的哪个版本换版） */
  reworkReason?: string
  /** 旧计划缺设备或资格版本：标记需要补录的条目 */
  missing?: MissingBasisItem[]
}

export type DaySlot = '上午' | '下午' | '夜间'

/** 一份证书依据：设备校准证与检验员资格证共用同一结构 */
export interface CertRef {
  /** 证书编号即版本号，换版 = 出现同设备/人员同方法的新编号 */
  certNo: string
  validFrom: string
  validUntil: string
}

/** 计划在“方法 + 日期 + 时段”上占用的设备与人员依据 */
export interface PlanBasis {
  equipmentId: string
  equipmentName: string
  equipmentMethod: string
  equipmentCert: CertRef
  inspectorId: string
  inspectorName: string
  inspectorMethod: string
  inspectorCert: CertRef
}

export interface MissingBasisItem {
  kind: '设备' | '检验员资格'
  detail: string
}

export interface ScheduleBatch {
  id: string
  createdAt: string
  createdBy: string
  state: BatchState
  planIds: string[]
  /** 退回重排前的原批次提示，便于核对未受影响计划为何保留 */
  note?: string
}

export interface EquipmentCalibration {
  certNo: string
  validFrom: string
  validUntil: string
}

export interface Equipment {
  id: string
  name: string
  model: string
  /** 该设备可承担的检测方法（UT/MT/PT…） */
  methods: string[]
  calibrations: EquipmentCalibration[]
}

export interface InspectorCert {
  method: string
  certNo: string
  validFrom: string
  validUntil: string
}

export interface Inspector {
  id: string
  name: string
  certs: InspectorCert[]
}

/** 锁定快照：每条计划的设备与人员依据逐项留痕 */
export interface LockSnapshot {
  lockedAt: string
  lockedBy: string
  batchIds: string[]
  items: Array<{
    planId: string
    batchId: string
    date: string
    slot: DaySlot
    method: string
    equipmentId: string
    equipmentName: string
    equipmentCertNo: string
    inspectorId: string
    inspectorName: string
    inspectorCertNo: string
  }>
}

/** 写入失败后用于按排程号恢复的 WAL 记录 */
export interface WriteJournalEntry {
  seq: number
  /** 排程号：恢复与幂等重放的唯一凭据 */
  scheduleNo: string
  op: '提交批次' | '证书换版' | '锁定'
  payload: unknown
  time: string
  applied: boolean
}

/** 原焊缝结果引用：旧计划升级/退回后，历史检测结果仍可查到来源 */
export interface RetiredResultRef {
  resultId: string
  planId: string
  batchId: string
  weldId: string
  method: string
  report: string
  outcome: string
}

export interface AuditEvent {
  id: string
  time: string
  actor: string
  action: string
  target: string
  detail: string
}

/** 后到的调度员看到的占用来源 */
export interface OccupancySource {
  planId: string
  batchId: string
  date: string
  slot: DaySlot
  kind: '设备' | '人员'
  resourceId: string
  resourceName: string
  owner: string
}
