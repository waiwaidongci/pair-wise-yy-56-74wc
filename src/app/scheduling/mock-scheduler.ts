import { ApolloLink, Observable } from '@apollo/client/core'
import type { Operation } from '@apollo/client/core'
import type {
  CreateInput, Equipment, Inspector, Method, OccupiedBy, Reservation,
  RescheduleInput, ScheduleAudit, ScheduleBoard, SchedulePlan, SlotPeriod,
} from './domain'

// ---------------------------------------------------------------------------
// 设备台账：超声仪 / 磁粉 / 渗透设备，各带校准证书版本
// ---------------------------------------------------------------------------
const equipment: Equipment[] = [
  { id:'EQ-UT-01', name:'数字超声仪', method:'UT', calibrationCertNo:'CAL-UT-2025-01', calibrationCertVersion:3, calibrationValidUntil:'2027-03-31', status:'可用' },
  { id:'EQ-UT-02', name:'数字超声仪', method:'UT', calibrationCertNo:'CAL-UT-2024-07', calibrationCertVersion:2, calibrationValidUntil:'2026-12-31', status:'可用' },
  { id:'EQ-MT-01', name:'磁粉探伤仪', method:'MT', calibrationCertNo:'CAL-MT-2025-04', calibrationCertVersion:1, calibrationValidUntil:'2027-01-15', status:'可用' },
  { id:'EQ-PT-01', name:'渗透探伤仪', method:'PT', calibrationCertNo:'CAL-PT-2025-06', calibrationCertVersion:1, calibrationValidUntil:'2026-11-30', status:'可用' },
]

// ---------------------------------------------------------------------------
// 检验员资格：人员持方法资格证书，带资格证书版本
// ---------------------------------------------------------------------------
const inspectors: Inspector[] = [
  { id:'I-01', name:'陈锋', methods:['UT','MT'], certNo:'INSP-UT-018', certVersion:2, certValidUntil:'2027-06-30' },
  { id:'I-02', name:'赵岚', methods:['UT','PT'], certNo:'INSP-UT-021', certVersion:1, certValidUntil:'2027-02-28' },
  { id:'I-03', name:'孙磊', methods:['MT','PT'], certNo:'INSP-MT-009', certVersion:3, certValidUntil:'2026-12-31' },
]

// ---------------------------------------------------------------------------
// 旧检测计划：只有日期与人员，缺少设备与资格版本依据
// 兼容升级为「待补录」；焊缝台账与检测结果保持不变、仍可查询
// ---------------------------------------------------------------------------
const plans: SchedulePlan[] = [
  { id:'IP-2026-0930-A', scheduleNo:'LEGACY-0930', date:'2026-09-30', method:'UT', period:'上午', weldIds:['W-105','W-106','W-108'], inspector:'陈锋', inspectorId:'I-01', state:'待补录', legacy:true },
  { id:'IP-2026-0929-B', scheduleNo:'LEGACY-0929', date:'2026-09-29', method:'UT', period:'下午', weldIds:['W-104'], inspector:'赵岚', inspectorId:'I-02', state:'待补录', legacy:true },
]

const reservations: Reservation[] = []

// 焊缝台账（静态参考数据，旧计划升级后焊缝结果仍按原台账查询）
const welds = [
  { id:'W-101', drawing:'SG-04-钢柱', component:'KZ-12 / 柱翼缘', joint:'全熔透坡口焊', method:'GMAW', welder:'王凯', qualification:'GB/T 9448 · 2027-06', qualificationValid:true, inspectionRatio:100, requiredRatio:100, status:'合格', x:18, y:24, repairs:0, defects:[] },
  { id:'W-104', drawing:'SG-07-屋面梁', component:'GL-21 / 下翼缘', joint:'对接焊缝', method:'SAW', welder:'刘强', qualification:'GB/T 9448 · 2028-03', qualificationValid:true, inspectionRatio:100, requiredRatio:100, status:'待复检', x:48, y:38, repairs:2, defects:[{id:'D-31',position:42,type:'夹渣',length:12,level:'Ⅱ级',method:'UT',report:'UT-2026-0918'}] },
  { id:'W-107', drawing:'SG-07-屋面梁', component:'GL-21 / 腹板', joint:'角焊缝', method:'FCAW', welder:'赵明', qualification:'GB/T 9448 · 2027-01', qualificationValid:true, inspectionRatio:20, requiredRatio:20, status:'返修中', x:61, y:42, repairs:1, defects:[{id:'D-32',position:68,type:'未熔合',length:18,level:'Ⅲ级',method:'MT',report:'MT-2026-0921'}] },
  { id:'W-109', drawing:'SG-12-平台梁', component:'PL-08 / 节点板', joint:'角焊缝', method:'SMAW', welder:'孙鹏', qualification:'GB/T 9448 · 2026-10-01', qualificationValid:false, inspectionRatio:10, requiredRatio:20, status:'待检测', x:78, y:60, repairs:0, defects:[] },
  { id:'W-112', drawing:'SG-12-平台梁', component:'PL-08 / 腹板', joint:'组合焊缝', method:'GMAW', welder:'王凯', qualification:'GB/T 9448 · 2027-06', qualificationValid:true, inspectionRatio:50, requiredRatio:50, status:'已关闭', x:36, y:68, repairs:0, defects:[] },
]

const audit: ScheduleAudit[] = [
  { id:'SA-1', time:'09:10', actor:'系统', action:'兼容升级', target:'IP-2026-0930-A', detail:'旧计划缺少设备与资格版本依据，已升级为待补录；焊缝检测结果仍可查询' },
  { id:'SA-2', time:'09:10', actor:'系统', action:'兼容升级', target:'IP-2026-0929-B', detail:'旧计划缺少设备与资格版本依据，已升级为待补录；焊缝检测结果仍可查询' },
]

let locked = false
let seq = 100
const nextId = (prefix: string) => `${prefix}-${seq++}`
const now = () => new Date().toLocaleTimeString('zh-CN', { hour:'2-digit', minute:'2-digit', hour12:false })
const today = () => new Date().toISOString().slice(0, 10)

// 排程号幂等表：写入失败后按排程号重放，命中已有结果，不重复占用
const dedup = new Map<string, Record<string, unknown>>()

// ---------------------------------------------------------------------------
// 规则：可用设备 / 人员资格
// ---------------------------------------------------------------------------
const activeReservations = () => reservations.filter((r) => r.state === '有效')

function findAvailableEquipment(method: Method): Equipment | undefined {
  return equipment.find((e) => e.method === method && e.status === '可用' && e.calibrationValidUntil >= today())
}
function findQualifiedInspector(method: Method): Inspector | undefined {
  return inspectors.find((i) => i.methods.includes(method) && i.certValidUntil >= today())
}

// 冲突检测：同一日期 + 时段，设备或人员已被有效预占 → 先到先得
function findConflict(date: string, period: SlotPeriod, equipmentId: string, inspectorId: string, excludeResId?: string): Reservation | undefined {
  return activeReservations().find((r) =>
    r.slotDate === date && r.slotPeriod === period &&
    (r.equipmentId === equipmentId || r.inspectorId === inspectorId) &&
    r.id !== excludeResId)
}

function toOccupiedBy(r: Reservation, equipmentId: string, inspectorId: string): OccupiedBy {
  const clashEquipment = r.equipmentId === equipmentId
  const clashInspector = r.inspectorId === inspectorId
  const resourceType = clashEquipment && clashInspector ? '设备与人员' : clashEquipment ? '设备' : '人员'
  const resourceLabel = clashEquipment
    ? `${r.equipmentId}（${equipment.find((e) => e.id === r.equipmentId)?.name ?? ''}）`
    : `${r.inspectorId}（${inspectors.find((i) => i.id === r.inspectorId)?.name ?? ''}）`
  return { planId: r.planId, scheduleNo: r.scheduleNo, resourceType, resourceLabel }
}

// ---------------------------------------------------------------------------
// 建计划：按方法、日期、时段预占设备与人员，固化双方证书版本
// ---------------------------------------------------------------------------
function createBatch(input: CreateInput, scheduleNo: string, actor: string, simulateFailure: boolean) {
  // 幂等：同一排程号重放，直接返回既有结果，不重复占用
  if (dedup.has(scheduleNo)) return { ...(dedup.get(scheduleNo) as object), replayed: true }

  const equip = input.equipmentId ? equipment.find((e) => e.id === input.equipmentId) : findAvailableEquipment(input.method)
  if (!equip || equip.method !== input.method || equip.status !== '可用') {
    return { ok:false, error:{ code:'NO_EQUIPMENT', message:`${input.method} 无可用设备（校准有效且状态可用），请先送检或调整方法` } }
  }
  const insp = input.inspectorId ? inspectors.find((i) => i.id === input.inspectorId) : findQualifiedInspector(input.method)
  if (!insp || !insp.methods.includes(input.method) || insp.certValidUntil < today()) {
    return { ok:false, error:{ code:'NO_INSPECTOR', message:`${input.method} 无持有效资格证书的检验员，不得开工` } }
  }

  const conflict = findConflict(input.date, input.period, equip.id, insp.id)
  if (conflict) {
    return { ok:false, error:{ code:'SLOT_CONFLICT', message:`该时段（${input.date} ${input.period}）资源已被预占，先到先得`, occupiedBy: toOccupiedBy(conflict, equip.id, insp.id) } }
  }

  const plan: SchedulePlan = {
    id: nextId('IP'), scheduleNo, date: input.date, method: input.method, period: input.period,
    weldIds: input.weldIds, inspector: insp.name, inspectorId: insp.id, state: '待执行',
    equipmentId: equip.id, equipmentCertVersion: equip.calibrationCertVersion,
    inspectorCertVersion: insp.certVersion,
  }
  const res: Reservation = {
    id: nextId('RS'), planId: plan.id, scheduleNo,
    equipmentId: equip.id, inspectorId: insp.id, method: input.method,
    slotDate: input.date, slotPeriod: input.period,
    equipmentCertVersion: equip.calibrationCertVersion, inspectorCertVersion: insp.certVersion,
    state: '有效', createdAt: now(),
  }
  plan.reservationId = res.id
  plans.unshift(plan)
  reservations.unshift(res)
  audit.unshift({
    id: nextId('SA'), time: now(), actor, action: '预占成功', target: plan.id,
    detail: `${input.date} ${input.period} ${input.method}：${equip.name} ${equip.id}（校准证书 v${equip.calibrationCertVersion}）+ ${insp.name}（资格证书 v${insp.certVersion}），排程号 ${scheduleNo}`,
  })

  const result = { ok:true, plan, reservation: res, replayed:false }
  dedup.set(scheduleNo, result)

  // 模拟“写入失败”：服务端已落库但响应丢失，客户端稍后按排程号恢复
  if (simulateFailure) {
    return { errors: [{ message: '写入失败（模拟）：服务端已预占但响应丢失，请按排程号恢复', extensions: { scheduleNo } }] }
  }
  return result
}

// ---------------------------------------------------------------------------
// 证书换版：超声仪校准 / 检验员资格在计划执行前换证
// 受影响计划（预占依据版本落后）退回重排；未受影响批次保留
// ---------------------------------------------------------------------------
function renewCertificate(target: 'equipment' | 'inspector', id: string, actor: string) {
  const affected: { id: string; scheduleNo: string }[] = []
  let newVersion = 0

  if (target === 'equipment') {
    const equip = equipment.find((e) => e.id === id)
    if (!equip) return { ok:false, error:{ message:'设备台账中不存在该设备' } }
    equip.calibrationCertVersion += 1
    newVersion = equip.calibrationCertVersion
    for (const r of activeReservations()) {
      if (r.equipmentId === id && r.equipmentCertVersion < newVersion) {
        r.state = '失效'
        const plan = plans.find((p) => p.id === r.planId)
        if (plan && plan.state !== '已完成') {
          plan.state = '待重排'
          affected.push({ id: plan.id, scheduleNo: plan.scheduleNo })
        }
      }
    }
    audit.unshift({
      id: nextId('SA'), time: now(), actor, action: '设备证书换版', target: id,
      detail: `${equip.name} ${id} 校准证书换版至 v${newVersion}；${affected.length} 个在执行计划退回重排，未受影响批次保留`,
    })
  } else {
    const insp = inspectors.find((i) => i.id === id)
    if (!insp) return { ok:false, error:{ message:'检验员台账中不存在该人员' } }
    insp.certVersion += 1
    newVersion = insp.certVersion
    for (const r of activeReservations()) {
      if (r.inspectorId === id && r.inspectorCertVersion < newVersion) {
        r.state = '失效'
        const plan = plans.find((p) => p.id === r.planId)
        if (plan && plan.state !== '已完成') {
          plan.state = '待重排'
          affected.push({ id: plan.id, scheduleNo: plan.scheduleNo })
        }
      }
    }
    audit.unshift({
      id: nextId('SA'), time: now(), actor, action: '资格证书换版', target: id,
      detail: `${insp.name}（${id}）检验资格证书换版至 v${newVersion}；${affected.length} 个在执行计划退回重排，未受影响批次保留`,
    })
  }

  return { ok:true, newVersion, affectedPlans: affected }
}

// ---------------------------------------------------------------------------
// 重排：受影响计划重新选择时段 / 设备 / 人员，再次冲突检测
// ---------------------------------------------------------------------------
function reschedule(planId: string, input: RescheduleInput, actor: string) {
  const plan = plans.find((p) => p.id === planId)
  if (!plan) return { ok:false, error:{ message:'计划不存在' } }
  const equip = equipment.find((e) => e.id === input.equipmentId)
  const insp = inspectors.find((i) => i.id === input.inspectorId)
  if (!equip || equip.method !== plan.method || equip.status !== '可用') {
    return { ok:false, error:{ message:'所选设备不满足检测方法或状态不可用' } }
  }
  if (!insp || !insp.methods.includes(plan.method)) {
    return { ok:false, error:{ message:'所选人员不具备该方法的有效资格' } }
  }
  const old = reservations.find((r) => r.id === plan.reservationId)
  const conflict = findConflict(input.date, input.period, equip.id, insp.id, old?.id)
  if (conflict) {
    return { ok:false, error:{ code:'SLOT_CONFLICT', message:`重排时段（${input.date} ${input.period}）仍被占用`, occupiedBy: toOccupiedBy(conflict, equip.id, insp.id) } }
  }

  if (old) old.state = '失效'
  const res: Reservation = {
    id: nextId('RS'), planId: plan.id, scheduleNo: plan.scheduleNo,
    equipmentId: equip.id, inspectorId: insp.id, method: plan.method,
    slotDate: input.date, slotPeriod: input.period,
    equipmentCertVersion: equip.calibrationCertVersion, inspectorCertVersion: insp.certVersion,
    state: '有效', createdAt: now(),
  }
  plan.date = input.date
  plan.period = input.period
  plan.equipmentId = equip.id
  plan.equipmentCertVersion = equip.calibrationCertVersion
  plan.inspectorId = insp.id
  plan.inspector = insp.name
  plan.inspectorCertVersion = insp.certVersion
  plan.reservationId = res.id
  plan.state = '待执行'
  reservations.unshift(res)
  audit.unshift({
    id: nextId('SA'), time: now(), actor, action: '重排完成', target: plan.id,
    detail: `${input.date} ${input.period} ${plan.method}：${equip.id}（校准证书 v${equip.calibrationCertVersion}）+ ${insp.name}（资格证书 v${insp.certVersion}）`,
  })
  return { ok:true, plan, reservation: res }
}

// ---------------------------------------------------------------------------
// 补录：旧计划（待补录）补齐设备与人员版本依据，原焊缝结果不受影响
// ---------------------------------------------------------------------------
function supplement(planId: string, equipmentId: string, inspectorId: string, actor: string) {
  const plan = plans.find((p) => p.id === planId)
  if (!plan) return { ok:false, error:{ message:'计划不存在' } }
  if (plan.state !== '待补录') return { ok:false, error:{ message:'仅待补录的旧计划需要补录' } }
  const equip = equipment.find((e) => e.id === equipmentId)
  const insp = inspectors.find((i) => i.id === inspectorId)
  if (!equip || equip.method !== plan.method || equip.status !== '可用') {
    return { ok:false, error:{ message:'所选设备不满足检测方法或状态不可用' } }
  }
  if (!insp || !insp.methods.includes(plan.method)) {
    return { ok:false, error:{ message:'所选人员不具备该方法的有效资格' } }
  }
  const conflict = findConflict(plan.date, plan.period, equip.id, insp.id)
  if (conflict) {
    return { ok:false, error:{ code:'SLOT_CONFLICT', message:`补录时段（${plan.date} ${plan.period}）已被占用`, occupiedBy: toOccupiedBy(conflict, equip.id, insp.id) } }
  }

  const res: Reservation = {
    id: nextId('RS'), planId: plan.id, scheduleNo: plan.scheduleNo,
    equipmentId: equip.id, inspectorId: insp.id, method: plan.method,
    slotDate: plan.date, slotPeriod: plan.period,
    equipmentCertVersion: equip.calibrationCertVersion, inspectorCertVersion: insp.certVersion,
    state: '有效', createdAt: now(),
  }
  plan.equipmentId = equip.id
  plan.equipmentCertVersion = equip.calibrationCertVersion
  plan.inspectorId = insp.id
  plan.inspector = insp.name
  plan.inspectorCertVersion = insp.certVersion
  plan.reservationId = res.id
  plan.state = '待执行'
  reservations.unshift(res)
  audit.unshift({
    id: nextId('SA'), time: now(), actor, action: '补录完成', target: plan.id,
    detail: `旧计划补齐依据：${equip.id}（校准证书 v${equip.calibrationCertVersion}）+ ${insp.name}（资格证书 v${insp.certVersion}）；焊缝检测结果仍可查询`,
  })
  return { ok:true, plan, reservation: res }
}

// ---------------------------------------------------------------------------
// 锁定前校验：每项计划都必须有可用设备与人员依据，否则列出阻塞项
// ---------------------------------------------------------------------------
function validateAndLock(actor: string) {
  const blockers: { planId: string; scheduleNo: string; reason: string }[] = []
  for (const plan of plans) {
    if (plan.state === '已完成') continue
    if (plan.state === '待补录') {
      blockers.push({ planId: plan.id, scheduleNo: plan.scheduleNo, reason: '旧计划待补录：缺少设备与检验员资格版本依据' })
      continue
    }
    if (plan.state === '待重排') {
      blockers.push({ planId: plan.id, scheduleNo: plan.scheduleNo, reason: '证书换版后尚未重排，预占依据已失效' })
      continue
    }
    const res = reservations.find((r) => r.id === plan.reservationId && r.state === '有效')
    if (!res) {
      blockers.push({ planId: plan.id, scheduleNo: plan.scheduleNo, reason: '预占记录已失效，需重新排程' })
      continue
    }
    const equip = equipment.find((e) => e.id === plan.equipmentId)
    if (!equip || equip.status !== '可用' || equip.method !== plan.method) {
      blockers.push({ planId: plan.id, scheduleNo: plan.scheduleNo, reason: '设备台账不可用或不满足检测方法' })
    } else if (equip.calibrationCertVersion !== plan.equipmentCertVersion) {
      blockers.push({ planId: plan.id, scheduleNo: plan.scheduleNo, reason: `超声仪校准证书已换版（预占 v${plan.equipmentCertVersion} → 台账 v${equip.calibrationCertVersion}），需重排` })
    }
    const insp = inspectors.find((i) => i.id === plan.inspectorId)
    if (!insp || !insp.methods.includes(plan.method)) {
      blockers.push({ planId: plan.id, scheduleNo: plan.scheduleNo, reason: '检验员不具备该方法有效资格' })
    } else if (insp.certVersion !== plan.inspectorCertVersion) {
      blockers.push({ planId: plan.id, scheduleNo: plan.scheduleNo, reason: `检验员资格证书已换版（预占 v${plan.inspectorCertVersion} → 台账 v${insp.certVersion}），需重排` })
    }
  }

  if (blockers.length) return { ok:false, locked:false, blockers }
  locked = true
  audit.unshift({
    id: nextId('SA'), time: now(), actor, action: '签字锁定', target: '检测批次',
    detail: '每项计划均已确认可用设备与人员依据，证书版本快照固化，可追溯当时预占',
  })
  return { ok:true, locked:true, blockers:[] }
}

function getBoard(): ScheduleBoard {
  return { equipment, inspectors, plans, reservations, audit, locked }
}

// 供焊缝台账查询使用的计划形态（旧字段保持兼容）
function legacyPlans() {
  return plans.map((p) => ({ id:p.id, date:p.date, method:p.method, weldIds:p.weldIds, inspector:p.inspector, state:p.state }))
}

// ---------------------------------------------------------------------------
// GraphQL 操作分发（模拟 Apollo 服务端）
// ---------------------------------------------------------------------------
function handleOperation(op: Operation): { data: any; errors?: any[] } {
  const v = op.variables as Record<string, any>
  switch (op.operationName) {
    case 'Welds':
      return { data: { welds, plans: legacyPlans() } }
    case 'ScheduleBoard':
      return { data: { scheduleBoard: getBoard() } }
    case 'CreateScheduleBatch': {
      const r = createBatch(v.input as CreateInput, v.scheduleNo as string, (v.actor as string) ?? '调度员', !!v.simulateFailure)
      if ((r as any).errors) return { data: { createScheduleBatch: null }, errors: (r as any).errors }
      return { data: { createScheduleBatch: r } }
    }
    case 'RenewCertificate':
      return { data: { renewCertificate: renewCertificate(v.target as 'equipment' | 'inspector', v.id as string, (v.actor as string) ?? '调度员') } }
    case 'ReschedulePlan':
      return { data: { reschedulePlan: reschedule(v.planId as string, v.input as RescheduleInput, (v.actor as string) ?? '调度员') } }
    case 'SupplementPlan':
      return { data: { supplementPlan: supplement(v.planId as string, v.equipmentId as string, v.inspectorId as string, (v.actor as string) ?? '调度员') } }
    case 'ValidateAndLock':
      return { data: { validateAndLock: validateAndLock((v.actor as string) ?? '质量负责人') } }
    default:
      return { data: {} }
  }
}

// 串行队列：保证两名调度员同时提交时按到达顺序处理，先到先得
let queue: Promise<void> = Promise.resolve()
function enqueue(task: () => void) {
  queue = queue.then(() => new Promise<void>((resolve) => setTimeout(resolve, 120))).then(task)
}

export const mockGraphqlLink = new ApolloLink((operation) => new Observable((observer) => {
  enqueue(() => {
    try {
      observer.next(handleOperation(operation))
      observer.complete()
    } catch (e) {
      observer.error(e)
    }
  })
}))
