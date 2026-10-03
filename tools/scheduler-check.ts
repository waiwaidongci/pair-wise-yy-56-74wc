import { mockGraphqlLink as link } from '../src/app/scheduling/mock-scheduler'

let failures = 0
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) console.log(`  PASS ${name}`)
  else { failures++; console.log(`  FAIL ${name}`, extra ?? '') }
}

function run(opName: string, variables: Record<string, any> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    const operation = { operationName: opName, variables, query: { kind: 'Document', definitions: [] } } as any
    const obs = (link as any).request(operation)
    obs.subscribe({ next: (r: any) => resolve(r), error: reject })
  })
}

const board = async () => (await run('ScheduleBoard')).data.scheduleBoard

async function main() {
  console.log('— 初始状态 —')
  let b = await board()
  check('设备台账 4 台', b.equipment.length === 4)
  check('检验员 3 名', b.inspectors.length === 3)
  check('旧计划兼容升级为待补录', b.plans.every((p: any) => p.state === '待补录' && p.legacy))
  check('初始无预占', b.reservations.length === 0)

  const welds = await run('Welds')
  check('焊缝结果仍可查（5 条）', welds.data.welds.length === 5)

  console.log('— 建计划预占 —')
  const r1 = await run('CreateScheduleBatch', {
    input: { method:'UT', date:'2026-10-09', period:'上午', weldIds:['W-105','W-106'], equipmentId:'EQ-UT-01', inspectorId:'I-01' },
    scheduleNo:'SCH-T1', actor:'调度员 A', simulateFailure:false,
  })
  check('建计划成功', r1.data.createScheduleBatch.ok === true, r1)
  check('预占固化设备 v3 / 人员 v2', r1.data.createScheduleBatch.reservation.equipmentCertVersion === 3 && r1.data.createScheduleBatch.reservation.inspectorCertVersion === 2)

  console.log('— 并发：同一时段先到先得 —')
  const base = { method:'UT', date:'2026-10-12', period:'上午', weldIds:['W-105'], equipmentId:'EQ-UT-01', inspectorId:'I-01' }
  const [c1, c2] = await Promise.all([
    run('CreateScheduleBatch', { input:base, scheduleNo:'SCH-C1', actor:'调度员 A', simulateFailure:false }),
    run('CreateScheduleBatch', { input:base, scheduleNo:'SCH-C2', actor:'调度员 B', simulateFailure:false }),
  ])
  const okOne = c1.data.createScheduleBatch.ok && !c2.data.createScheduleBatch.ok
  const okTwo = c2.data.createScheduleBatch.ok && !c1.data.createScheduleBatch.ok
  check('两笔并发仅一笔放行', okOne || okTwo, { c1: c1.data.createScheduleBatch.ok, c2: c2.data.createScheduleBatch.ok })
  const loser = okOne ? c2.data.createScheduleBatch : c1.data.createScheduleBatch
  check('后到者看到占用来源', !!loser.error.occupiedBy && loser.error.occupiedBy.resourceType === '设备与人员', loser.error)
  check('占用来源含排程号', /^SCH-/.test(loser.error.occupiedBy.scheduleNo), loser.error.occupiedBy)

  console.log('— 排程号幂等：重放不重复占用 —')
  const replay = await run('CreateScheduleBatch', {
    input: { method:'UT', date:'2026-10-09', period:'上午', weldIds:['W-105','W-106'], equipmentId:'EQ-UT-01', inspectorId:'I-01' },
    scheduleNo:'SCH-T1', actor:'调度员 A', simulateFailure:false,
  })
  check('重放命中既有结果', replay.data.createScheduleBatch.replayed === true)
  b = await board()
  check('预占总数仍为 2（T1 + 并发胜方）', b.reservations.filter((r: any) => r.state === '有效').length === 2, b.reservations.length)

  console.log('— 写入失败后按排程号恢复 —')
  const fail = await run('CreateScheduleBatch', {
    input: { method:'MT', date:'2026-10-14', period:'下午', weldIds:['W-107'], equipmentId:'EQ-MT-01', inspectorId:'I-01' },
    scheduleNo:'SCH-F1', actor:'调度员 A', simulateFailure:true,
  })
  check('模拟写入失败返回错误', !!fail.errors && fail.errors[0].message.includes('排程号恢复'), fail)
  b = await board()
  const before = b.reservations.length
  const recover = await run('CreateScheduleBatch', {
    input: { method:'MT', date:'2026-10-14', period:'下午', weldIds:['W-107'], equipmentId:'EQ-MT-01', inspectorId:'I-01' },
    scheduleNo:'SCH-F1', actor:'调度员 A', simulateFailure:false,
  })
  check('按排程号恢复成功', recover.data.createScheduleBatch.ok === true)
  b = await board()
  check('恢复后不重复占用（重放命中既有预占，总数不变）', b.reservations.length === before, { before, after: b.reservations.length })

  console.log('— 证书换版：受影响退回重排，未受影响保留 —')
  // 先用 EQ-UT-02 建一个不受 EQ-UT-01 换版影响的计划
  await run('CreateScheduleBatch', {
    input: { method:'UT', date:'2026-10-20', period:'下午', weldIds:['W-109'], equipmentId:'EQ-UT-02', inspectorId:'I-02' },
    scheduleNo:'SCH-U2', actor:'调度员 A', simulateFailure:false,
  })
  const renew = await run('RenewCertificate', { target:'equipment', id:'EQ-UT-01', actor:'调度员 A' })
  check('设备证书换版至 v4', renew.data.renewCertificate.newVersion === 4)
  check('受影响计划退回重排（T1 + 并发胜方 = 2）', renew.data.renewCertificate.affectedPlans.length === 2, renew.data.renewCertificate.affectedPlans)
  b = await board()
  const t1 = b.plans.find((p: any) => p.scheduleNo === 'SCH-T1')
  const u2 = b.plans.find((p: any) => p.scheduleNo === 'SCH-U2')
  check('T1 待重排', t1.state === '待重排', t1.state)
  check('未受影响批次 U2 保留待执行', u2.state === '待执行', u2.state)
  const t1Res = b.reservations.find((r: any) => r.scheduleNo === 'SCH-T1')
  check('失效预占标记失效', t1Res.state === '失效', t1Res.state)

  console.log('— 重排 —')
  const rs = await run('ReschedulePlan', {
    planId: t1.id,
    input: { date:'2026-10-21', period:'上午', equipmentId:'EQ-UT-02', inspectorId:'I-02' },
    actor:'调度员 A',
  })
  check('重排成功', rs.data.reschedulePlan.ok === true, rs.data.reschedulePlan)

  // 并发胜方同样受换证影响，一并重排
  b = await board()
  for (const p of b.plans.filter((x: any) => x.state === '待重排')) {
    const r2 = await run('ReschedulePlan', {
      planId: p.id,
      input: { date:'2026-10-22', period:'上午', equipmentId:'EQ-UT-02', inspectorId:'I-02' },
      actor:'调度员 A',
    })
    check(`受影响计划 ${p.id} 已重排`, r2.data.reschedulePlan.ok === true, r2.data.reschedulePlan)
  }

  b = await board()
  const t1After = b.plans.find((p: any) => p.id === t1.id)
  check('重排后计划待执行且依据更新为 v2/v1', t1After.state === '待执行' && t1After.equipmentCertVersion === 2 && t1After.inspectorCertVersion === 1, t1After)

  console.log('— 旧计划补录 —')
  const leg = b.plans.find((p: any) => p.legacy)
  const sup = await run('SupplementPlan', { planId: leg.id, equipmentId:'EQ-UT-02', inspectorId:'I-02', actor:'调度员 A' })
  check('补录成功', sup.data.supplementPlan.ok === true, sup.data.supplementPlan)
  b = await board()
  const legAfter = b.plans.find((p: any) => p.id === leg.id)
  check('补录后待执行且保留 legacy 标记', legAfter.state === '待执行' && legAfter.legacy === true, legAfter)

  console.log('— 锁定前校验 —')
  const lock1 = await run('ValidateAndLock', { actor:'质量负责人' })
  check('仍有旧计划未补录时锁定被阻塞', !lock1.data.validateAndLock.ok && lock1.data.validateAndLock.blockers.length > 0, lock1.data.validateAndLock)
  const leg2 = b.plans.find((p: any) => p.legacy && p.state === '待补录')
  if (leg2) {
    await run('SupplementPlan', { planId: leg2.id, equipmentId:'EQ-UT-02', inspectorId:'I-02', actor:'调度员 A' })
  }
  const lock2 = await run('ValidateAndLock', { actor:'质量负责人' })
  check('全部计划依据齐全后锁定成功', lock2.data.validateAndLock.ok === true && lock2.data.validateAndLock.locked === true, lock2.data.validateAndLock)

  console.log(failures ? `\n${failures} 项失败` : '\n全部通过')
  process.exit(failures ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
