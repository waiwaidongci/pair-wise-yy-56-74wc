import { Component, inject } from '@angular/core'
import { CommonModule } from '@angular/common'
import { Store } from '@ngrx/store'
import { ButtonModule } from 'primeng/button'
import { TimelineModule } from 'primeng/timeline'
import { TagModule } from 'primeng/tag'
import { WeldState } from '../store/weld.reducer'
import { SchedulingService } from '../services/scheduling.service'
import * as A from '../store/weld.actions'

@Component({
  selector: 'app-approvals', standalone: true,
  imports: [CommonModule, ButtonModule, TimelineModule, TagModule],
  template: `
    <main class="page">
      <div class="page-head">
        <div>
          <p class="eyebrow">锁定前逐项确认设备与人员依据</p>
          <h1>批次确认与签字锁定</h1>
          <p>锁定前对每项计划核对当日有效的设备校准与检验员资格版本；任一缺失或已退回重排，整批拒绝签字。</p>
        </div>
      </div>

      <div class="notice card" *ngIf="state.notice"><i class="pi pi-info-circle"></i><span>{{state.notice}}</span></div>

      <section class="card" *ngFor="let batch of batches">
        <div class="batch-head">
          <div>
            <b>{{batch.id}}</b>
            <small>{{batch.createdBy}} 建批于 {{batch.createdAt | slice:0:16}} · {{batch.planIds.length}} 项计划</small>
            <p class="batch-note" *ngIf="batch.note">{{batch.note}}</p>
          </div>
          <p-tag [value]="batch.state" [severity]="batch.state === '已锁定' ? 'success' : batch.state === '待补录' ? 'warn' : 'info'" />
          <p-button label="刷新依据核对" text (onClick)="refresh(batch.id)" />
          <p-button [label]="batch.state === '已锁定' ? '已签字锁定' : '逐项确认并锁定'" [disabled]="batch.state === '已锁定'" icon="pi pi-lock" (onClick)="lock(batch.id)" />
        </div>

        <table class="basis-table">
          <thead><tr><th>计划</th><th>日期/时段</th><th>设备 + 校准版本</th><th>人员 + 资格版本</th><th>核对结果</th></tr></thead>
          <tbody>
            <tr *ngFor="let plan of plansOf(batch.planIds)">
              <td><b>{{plan.id}}</b><small class="block">{{plan.method}} · {{plan.weldIds.length}} 条焊缝</small></td>
              <td>{{plan.date}} {{plan.slot || '—'}}</td>
              <td>
                <ng-container *ngIf="plan.basis">{{plan.basis.equipmentName}}<small class="block cert">{{plan.basis.equipmentCert.certNo}}（{{plan.basis.equipmentCert.validFrom}}~{{plan.basis.equipmentCert.validUntil}}）</small></ng-container>
                <span *ngIf="!plan.basis" class="bad">缺设备依据</span>
              </td>
              <td>
                <ng-container *ngIf="plan.basis">{{plan.basis.inspectorName}}<small class="block cert">{{plan.basis.inspectorCert.certNo}}（{{plan.basis.inspectorCert.validFrom}}~{{plan.basis.inspectorCert.validUntil}}）</small></ng-container>
                <span *ngIf="!plan.basis" class="bad">缺资格版本</span>
              </td>
              <td>
                <ng-container *ngIf="checks[plan.id] as c">
                  <p-tag *ngIf="c.ok" value="依据齐备" severity="success" />
                  <div *ngIf="!c.ok" class="bad"><p-tag value="不可锁定" severity="danger" /><small class="block" *ngFor="let r of c.reasons">· {{r}}</small></div>
                </ng-container>
                <p-tag *ngIf="plan.state === '已退回重排'" value="已退回重排" severity="danger" />
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <div class="grid-2 mt-4">
        <section class="card">
          <h2 class="panel-title">待审核焊缝</h2>
          <div class="review" *ngFor="let weld of reviewWelds">
            <div><b>{{weld.id}} · {{weld.component}}</b><small>{{weld.method}} · {{weld.welder}} · 返修 {{weld.repairs}} 次</small></div>
            <p-tag [value]="weld.status" [severity]="weld.status === '待复检' ? 'warn' : 'danger'" />
            <p-button label="要求复检" severity="danger" text size="small" />
            <p-button label="确认合格" size="small" (onClick)="confirm(weld.id)" />
          </div>
          <p-button label="导出质量追溯包" icon="pi pi-file-export" severity="secondary" styleClass="w-full" />
        </section>
        <aside class="card">
          <h2 class="panel-title">完整审计时间线</h2>
          <p-timeline [value]="state.audit" align="left">
            <ng-template #content let-event>
              <div class="audit"><div><b>{{event.actor}} · {{event.action}}</b><span>{{event.time}}</span></div><p><strong>{{event.target}}</strong> {{event.detail}}</p></div>
            </ng-template>
          </p-timeline>
        </aside>
      </div>
    </main>
  `,
  styles: [`
    .notice{display:flex;gap:10px;align-items:flex-start;background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;padding:10px 14px;border-radius:8px;margin:14px 0}
    .batch-head{display:grid;grid-template-columns:1fr auto auto auto;gap:12px;align-items:center}.batch-head small{color:#7a8798;display:block;margin-top:3px}.batch-note{color:#b45309;font-size:12px;margin:6px 0 0}
    .basis-table{width:100%;border-collapse:collapse;margin-top:12px;font-size:13px}.basis-table th,.basis-table td{border-top:1px solid #eef2f7;padding:9px 8px;text-align:left;vertical-align:top}.basis-table th{color:#64748b;font-weight:600}
    .block,.cert{display:block}.cert{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:#475569}.bad{color:#b91c1c;font-size:12px}
    .review{display:grid;grid-template-columns:1fr auto auto auto;gap:8px;align-items:center;padding:12px 0;border-bottom:1px solid #edf0f5}.review b,.review small{display:block}.review small{color:#7a8798;margin-top:4px}
    .audit{background:#fff;border:1px solid #e1e7ef;border-radius:6px;padding:10px}.audit>div{display:flex;justify-content:space-between}.audit span{color:#7a8798;font-size:12px}.audit p{margin:5px 0 0;font-size:13px}
    .mt-4{margin-top:16px}
  `],
})
export class ApprovalsComponent {
  private readonly store = inject(Store<{ welds: WeldState }>)
  private readonly scheduling = inject(SchedulingService)
  state!: WeldState
  /** 计划号 → 锁定前依据核对结果 */
  checks: Record<string, { ok: boolean; reasons: string[] }> = {}

  constructor() {
    this.store.select('welds').subscribe((state) => {
      this.state = state
      if (state.scheduling) for (const batch of state.scheduling.batches) this.refresh(batch.id)
    })
  }

  get batches() { return this.state?.scheduling?.batches ?? [] }
  plansOf(ids: string[]) {
    const map = new Map((this.state?.scheduling?.plans ?? []).map((p) => [p.id, p]))
    return ids.map((id) => map.get(id)!).filter(Boolean)
  }
  get reviewWelds() { return (this.state?.welds ?? []).filter((item) => ['待复检', '返修中', '待检测'].includes(item.status)) }

  refresh(batchId: string) {
    const s = this.state?.scheduling
    if (!s) return
    const rows = this.scheduling.preLockCheck(s, [batchId])
    this.checks = { ...this.checks, ...Object.fromEntries(rows.map((r) => [r.planId, { ok: r.ok, reasons: r.reasons }])) }
  }

  async lock(batchId: string) { await this.scheduling.lock([batchId]) }
  confirm(id: string) { this.store.dispatch(A.advanceWeld({ id, status: '合格' })) }
}
