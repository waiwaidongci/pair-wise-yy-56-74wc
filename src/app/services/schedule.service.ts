import { inject, Injectable } from '@angular/core'
import { Apollo, gql } from 'apollo-angular'
import { Store } from '@ngrx/store'
import { catchError, map, of } from 'rxjs'
import type { Observable } from 'rxjs'
import type { ActionResult, CreateInput, RescheduleInput, ScheduleBoard } from '../scheduling/domain'
import type { ScheduleState } from '../store/schedule.reducer'
import * as A from '../store/schedule.actions'

const BOARD_QUERY = gql`query ScheduleBoard { scheduleBoard {
  equipment { id name method calibrationCertNo calibrationCertVersion calibrationValidUntil status }
  inspectors { id name methods certNo certVersion certValidUntil }
  plans { id scheduleNo date method period weldIds inspector inspectorId state equipmentId equipmentCertVersion inspectorCertVersion reservationId legacy }
  reservations { id planId scheduleNo equipmentId inspectorId method slotDate slotPeriod equipmentCertVersion inspectorCertVersion state createdAt }
  audit { id time actor action target detail }
  locked
} }`

const CREATE_MUTATION = gql`mutation CreateScheduleBatch($input: CreateInput!, $scheduleNo: String!, $actor: String!, $simulateFailure: Boolean!) {
  createScheduleBatch(input: $input, scheduleNo: $scheduleNo, actor: $actor, simulateFailure: $simulateFailure) {
    ok replayed
    plan { id scheduleNo date method period state equipmentId inspector }
    error { code message occupiedBy { planId scheduleNo resourceType resourceLabel } }
  }
}`

const RENEW_MUTATION = gql`mutation RenewCertificate($target: String!, $id: String!, $actor: String!) {
  renewCertificate(target: $target, id: $id, actor: $actor) {
    ok newVersion
    affectedPlans { id scheduleNo }
    error { message }
  }
}`

const RESCHEDULE_MUTATION = gql`mutation ReschedulePlan($planId: String!, $input: RescheduleInput!, $actor: String!) {
  reschedulePlan(planId: $planId, input: $input, actor: $actor) {
    ok
    plan { id scheduleNo date period state }
    error { code message occupiedBy { planId scheduleNo resourceType resourceLabel } }
  }
}`

const SUPPLEMENT_MUTATION = gql`mutation SupplementPlan($planId: String!, $equipmentId: String!, $inspectorId: String!, $actor: String!) {
  supplementPlan(planId: $planId, equipmentId: $equipmentId, inspectorId: $inspectorId, actor: $actor) {
    ok
    plan { id scheduleNo state }
    error { message }
  }
}`

const LOCK_MUTATION = gql`mutation ValidateAndLock($actor: String!) {
  validateAndLock(actor: $actor) {
    ok locked
    blockers { planId scheduleNo reason }
  }
}`

@Injectable({ providedIn: 'root' })
export class ScheduleService {
  private readonly apollo = inject(Apollo)
  private readonly store = inject(Store<{ schedule: ScheduleState }>)

  loadBoard() {
    this.apollo.query<{ scheduleBoard: ScheduleBoard }>({ query: BOARD_QUERY, fetchPolicy: 'network-only' })
      .pipe(map((r) => r.data.scheduleBoard))
      .subscribe((board) => this.store.dispatch(A.scheduleBoardLoaded({ board })))
  }

  createBatch(input: CreateInput, scheduleNo: string, actor: string, simulateFailure: boolean) {
    return this.apollo.mutate<{ createScheduleBatch: any }>({
      mutation: CREATE_MUTATION,
      variables: { input, scheduleNo, actor, simulateFailure },
    }).pipe(
      map((r): ActionResult => {
        const d = r.data!.createScheduleBatch
        if (d.ok) {
          return { ok:true, kind:'create', scheduleNo, replayed:!!d.replayed, message:`排程批次 ${d.plan.id} 预占成功（${d.plan.date} ${d.plan.period}）` }
        }
        return { ok:false, kind:'create', scheduleNo, message:d.error.message, occupiedBy:d.error.occupiedBy }
      }),
      catchError((e: { message: string }): Observable<ActionResult> =>
        of({ ok:false, kind:'create', scheduleNo, networkError:true, message:`写入失败：${e.message ?? '未收到服务端确认'}` })),
    )
  }

  renewCertificate(target: 'equipment' | 'inspector', id: string, actor: string) {
    return this.apollo.mutate<{ renewCertificate: any }>({
      mutation: RENEW_MUTATION, variables: { target, id, actor },
    }).pipe(map((r): ActionResult => {
      const d = r.data!.renewCertificate
      if (d.ok) {
        return { ok:true, kind:'renew', message:`证书已换版至 v${d.newVersion}`, affected:d.affectedPlans }
      }
      return { ok:false, kind:'renew', message:d.error.message }
    }))
  }

  reschedule(planId: string, input: RescheduleInput, actor: string) {
    return this.apollo.mutate<{ reschedulePlan: any }>({
      mutation: RESCHEDULE_MUTATION, variables: { planId, input, actor },
    }).pipe(map((r): ActionResult => {
      const d = r.data!.reschedulePlan
      if (d.ok) return { ok:true, kind:'reschedule', message:`计划 ${d.plan.id} 已重排（${d.plan.date} ${d.plan.period}），预占依据已更新` }
      return { ok:false, kind:'reschedule', message:d.error.message, occupiedBy:d.error.occupiedBy }
    }))
  }

  supplement(planId: string, equipmentId: string, inspectorId: string, actor: string) {
    return this.apollo.mutate<{ supplementPlan: any }>({
      mutation: SUPPLEMENT_MUTATION, variables: { planId, equipmentId, inspectorId, actor },
    }).pipe(map((r): ActionResult => {
      const d = r.data!.supplementPlan
      if (d.ok) return { ok:true, kind:'supplement', message:`计划 ${d.plan.id} 补录完成，设备与人员依据已补齐` }
      return { ok:false, kind:'supplement', message:d.error.message }
    }))
  }

  validateAndLock(actor: string) {
    return this.apollo.mutate<{ validateAndLock: any }>({
      mutation: LOCK_MUTATION, variables: { actor },
    }).pipe(map((r): ActionResult => {
      const d = r.data!.validateAndLock
      if (d.ok) return { ok:true, kind:'lock', message:'锁定完成：每项计划均具备可用设备与人员依据，版本快照已固化' }
      return { ok:false, kind:'lock', message:`${d.blockers.length} 项计划不满足锁定条件`, blockers:d.blockers }
    }))
  }
}
