import { Component, inject } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { Store } from '@ngrx/store'
import { TableModule } from 'primeng/table'
import { TagModule } from 'primeng/tag'
import { ButtonModule } from 'primeng/button'
import { DialogModule } from 'primeng/dialog'
import { InputTextModule } from 'primeng/inputtext'
import { TextareaModule } from 'primeng/textarea'
import { SelectButtonModule } from 'primeng/selectbutton'
import { SelectModule } from 'primeng/select'
import { WeldState } from '../store/weld.reducer'
import { SchedulingService } from '../services/scheduling.service'
import type { DaySlot, PlanState } from '../types'
import * as A from '../store/weld.actions'

interface BatchFormRow {
  date: string
  slot: DaySlot
  method: string
  weldIdsText: string
  equipmentId: string
  inspectorId: string
}

@Component({
  selector: 'app-inspections', standalone: true,
  imports: [CommonModule, FormsModule, TableModule, TagModule, ButtonModule, DialogModule, InputTextModule, TextareaModule, SelectButtonModule, SelectModule],
  template: `
    <main class="page">
      <div class="page-head">
        <div>
          <p class="eyebrow">设备台账 × 检验员资格 × 检测计划</p>
          <h1>检测排程批次</h1>
          <p>建计划即按方法、日期、时段预占设备与人员；证书执行前换版则退回重排，未受影响批次保留。</p>
        </div>
        <p-button label="新建排程批次" icon="pi pi-plus" (onClick)="openCreate()" />
      </div>

      <div class="notice card" *ngIf="state.notice"><i class="pi pi-info-circle"></i><span>{{state.notice}}</span></div>

      <!-- 设备台账与检验员资格 -->
      <div class="grid-2">
        <section class="card">
          <h2 class="panel-title">超声 / 磁粉 / 渗透设备台账（校准版本）</h2>
          <p-table [value]="equipment" [tableStyle]="{ 'min-width':'30rem' }">
            <ng-template #header><tr><th>设备</th><th>方法</th><th>当前校准证书</th><th>有效期</th></tr></ng-template>
            <ng-template #body let-e>
              <tr>
                <td><b>{{e.name}}</b><small class="block">{{e.id}} · {{e.model}}</small></td>
                <td>{{e.methods.join(' / ')}}</td>
                <td><span class="cert">{{latestCal(e.id)?.certNo || '—'}}</span></td>
                <td><small *ngIf="latestCal(e.id)">{{latestCal(e.id)?.validFrom}} ~ {{latestCal(e.id)?.validUntil}}</small>
                  <p-button label="换版" size="small" text (onClick)="recert('设备', e.id, e.methods[0])" /></td>
              </tr>
            </ng-template>
          </p-table>
        </section>
        <section class="card">
          <h2 class="panel-title">检验员资格（按方法的证书版本）</h2>
          <p-table [value]="inspectors" [tableStyle]="{ 'min-width':'30rem' }">
            <ng-template #header><tr><th>检验员</th><th>方法 / 资格版本</th><th>有效期</th><th></th></tr></ng-template>
            <ng-template #body let-i>
              <ng-container *ngFor="let c of i.certs">
                <tr>
                  <td><b>{{i.name}}</b><small class="block">{{i.id}}</small></td>
                  <td>{{c.method}} · <span class="cert">{{c.certNo}}</span></td>
                  <td><small>{{c.validFrom}} ~ {{c.validUntil}}</small></td>
                  <td><p-button label="换证" size="small" text (onClick)="recert('检验员资格', i.id, c.method)" /></td>
                </tr>
              </ng-container>
            </ng-template>
          </p-table>
        </section>
      </div>

      <!-- 排程批次 -->
      <section class="card mt-4">
        <h2 class="panel-title">排程批次与占用依据</h2>
        <p-table [value]="batchRows" [paginator]="true" [rows]="8" [rowHover]="true">
          <ng-template #header>
            <tr><th>排程号 / 批次</th><th>计划 / 日期时段</th><th>占用设备（校准版本）</th><th>占用人员（资格版本）</th><th>焊缝</th><th>状态</th><th>依据 / 处置</th></tr>
          </ng-template>
          <ng-template #body let-row>
            <tr>
              <td><b>{{row.plan.id}}</b><small class="block">{{row.batchId}}</small></td>
              <td>{{row.plan.date}} {{row.plan.slot || '—'}}<small class="block">{{row.plan.method}}</small></td>
              <td>
                <ng-container *ngIf="row.plan.basis">{{row.plan.basis.equipmentName}}<small class="block cert">{{row.plan.basis.equipmentCert.certNo}}</small></ng-container>
                <span *ngIf="!row.plan.basis" class="muted">缺设备依据</span>
              </td>
              <td>
                <ng-container *ngIf="row.plan.basis">{{row.plan.basis.inspectorName}}<small class="block cert">{{row.plan.basis.inspectorCert.certNo}}</small></ng-container>
                <span *ngIf="!row.plan.basis" class="muted">缺资格版本</span>
              </td>
              <td>{{row.plan.weldIds.length}} 条</td>
              <td><p-tag [value]="row.plan.state" [severity]="severity(row.plan.state)" /></td>
              <td>
                <p-button *ngIf="row.plan.state === '待补录'" label="补录" size="small" (onClick)="openBackfill(row.plan.id, row.plan.method)" />
                <p-button *ngIf="row.plan.state === '已退回重排'" label="查看原因" size="small" text severity="danger" (onClick)="reason = row.plan.reworkReason || '证书在执行前换版'; reasonVisible = true" />
                <span *ngIf="row.plan.state === '待执行' || row.plan.state === '执行中'" class="muted">依据已锁定到版本</span>
              </td>
            </tr>
          </ng-template>
        </p-table>
      </section>

      <div class="grid-2 mt-4">
        <!-- 并发与恢复演练 -->
        <section class="card">
          <h2 class="panel-title">并发提交与写入恢复演练</h2>
          <p class="hint">两名调度员点同一时段：先到者放行，后到者看到占用来源。也可模拟写日志后崩溃，再按排程号恢复。</p>
          <div class="form">
            <label>调度员甲（先提交）</label>
            <p-button label="甲：提交 2026-10-08 上午 UT" icon="pi pi-user" styleClass="w-full" (onClick)="raceSubmit('调度员甲', 'SCH-RACE-A')" />
            <label>调度员乙（后提交，同时段同设备/人员）</label>
            <p-button label="乙：提交 2026-10-08 上午 UT" icon="pi pi-users" severity="secondary" styleClass="w-full" (onClick)="raceSubmit('调度员乙', 'SCH-RACE-B')" />
            <label>写入失败后按排程号恢复（重放不重复占用）</label>
            <div class="row">
              <input pInputText [(ngModel)]="recoverNo" placeholder="如 SCH-RECOVER-1" />
              <p-button label="崩溃后恢复" severity="warn" (onClick)="doRecover()" />
            </div>
            <p-button label="模拟：先写日志再崩溃（SCH-RECOVER-1）" severity="danger" text (onClick)="crashDemo()" />
          </div>
        </section>

        <!-- 历史结果可查 -->
        <section class="card">
          <h2 class="panel-title">原焊缝结果（旧计划升级/退回后仍可查）</h2>
          <p-table [value]="retiredResults" [paginator]="true" [rows]="5">
            <ng-template #header><tr><th>结果号</th><th>焊缝 / 方法</th><th>报告</th><th>结论</th></tr></ng-template>
            <ng-template #body let-r>
              <tr><td>{{r.resultId}}<small class="block">来自 {{r.planId}}</small></td><td>{{r.weldId}} · {{r.method}}</td><td>{{r.report}}</td><td><small>{{r.outcome}}</small></td></tr>
            </ng-template>
          </p-table>
        </section>
      </div>

      <!-- 返修流转（保留原有闭环） -->
      <aside class="card mt-4">
        <h2 class="panel-title">返修状态流转</h2>
        <div class="step" *ngFor="let weld of repairWelds">
          <div><b>{{weld.id}} · {{weld.component}}</b><small>{{weld.defects.length}} 个缺陷 · 已返修 {{weld.repairs}} 次</small></div>
          <p-tag [value]="weld.status" severity="warn" />
          <p-selectbutton [options]="['返修中','待复检','合格']" [ngModel]="weld.status" (ngModelChange)="advance(weld.id,$event)" />
        </div>
      </aside>

      <!-- 新建批次 -->
      <p-dialog header="新建排程批次（按方法/日期/时段预占）" [(visible)]="createVisible" [modal]="true" [style]="{width:'680px'}">
        <div class="form">
          <label>提交调度员</label>
          <input pInputText [(ngModel)]="createdBy" placeholder="调度员姓名" />
          <div class="grid-2">
            <div><label>日期</label><input pInputText type="date" [(ngModel)]="row.date" /></div>
            <div><label>时段</label>
              <p-selectbutton [options]="slots" [(ngModel)]="row.slot" />
            </div>
          </div>
          <div class="grid-2">
            <div><label>检测方法</label><p-select [options]="methods" [(ngModel)]="row.method" optionLabel="name" optionValue="code" /></div>
            <div><label>焊缝编号（逗号分隔）</label><input pInputText [(ngModel)]="row.weldIdsText" placeholder="W-104,W-107" /></div>
          </div>
          <div class="grid-2">
            <div><label>预占设备</label><p-select [options]="equipmentOptions" [(ngModel)]="row.equipmentId" optionLabel="name" optionValue="id" placeholder="选择设备" /></div>
            <div><label>预占检验员</label><p-select [options]="inspectorOptions" [(ngModel)]="row.inspectorId" optionLabel="name" optionValue="id" placeholder="选择检验员" /></div>
          </div>
          <div class="preview" *ngIf="basisPreview">
            <b>建计划时锁定依据：</b>
            <span [class.bad]="!basisPreview.ok">
              {{ basisPreview.ok ? (basisPreview.text) : basisPreview.text }}
            </span>
          </div>
        </div>
        <ng-template #footer>
          <p-button label="取消" severity="secondary" (onClick)="createVisible=false" />
          <p-button label="提交并预占" [disabled]="!canSubmit" (onClick)="doSubmit()" />
        </ng-template>
      </p-dialog>

      <!-- 补录 -->
      <p-dialog [header]="'待补录计划补录：' + backfillPlanId" [(visible)]="backfillVisible" [modal]="true" [style]="{width:'560px'}">
        <div class="form">
          <div class="grid-2">
            <div><label>日期</label><input pInputText type="date" [(ngModel)]="backfill.date" /></div>
            <div><label>时段</label><p-selectbutton [options]="slots" [(ngModel)]="backfill.slot" /></div>
          </div>
          <label *ngIf="needsMethodSplit">旧方法「{{backfillOriginalMethod}}」请拆成持证的单一方法</label>
          <p-select *ngIf="needsMethodSplit" [options]="methods" [(ngModel)]="backfill.method" optionLabel="name" optionValue="code" />
          <label>设备</label><p-select [options]="equipmentOptions" [(ngModel)]="backfill.equipmentId" optionLabel="name" optionValue="id" placeholder="选择设备" />
          <label>检验员</label><p-select [options]="inspectorOptions" [(ngModel)]="backfill.inspectorId" optionLabel="name" optionValue="id" placeholder="选择检验员" />
        </div>
        <ng-template #footer>
          <p-button label="取消" severity="secondary" (onClick)="backfillVisible=false" />
          <p-button label="补录并占用" (onClick)="doBackfill()" />
        </ng-template>
      </p-dialog>

      <p-dialog header="退回重排原因" [(visible)]="reasonVisible" [modal]="true" [style]="{width:'480px'}">
        <p class="reason">{{reason}}</p>
        <ng-template #footer><p-button label="知道了" (onClick)="reasonVisible=false" /></ng-template>
      </p-dialog>
    </main>
  `,
  styles: [`
    .notice{display:flex;gap:10px;align-items:flex-start;background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af;padding:10px 14px;border-radius:8px;margin:14px 0}
    .block,.cert{display:block}.cert{font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#334155}.muted{color:#94a3b8;font-size:12px}.bad{color:#b91c1c}
    .step{display:grid;grid-template-columns:1fr auto;gap:9px;padding:12px 0;border-bottom:1px solid #edf0f5}.step>div,.step small{display:block}.step small{color:#7a8798;margin-top:4px}.step p-selectbutton{grid-column:1/-1}
    .form{display:grid;gap:9px}.form input,.form select{padding:9px;border:1px solid #cbd5e1;border-radius:6px;width:100%}.form label{font-size:12px;color:#64748b;margin-top:6px}.form .row{display:flex;gap:8px}.form .row input{flex:1}
    .mt-3{margin-top:12px}.mt-4{margin-top:16px}.preview{background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:10px;font-size:13px}.hint{color:#64748b;font-size:12px}.reason{line-height:1.7}
  `],
})
export class InspectionsComponent {
  private readonly store = inject(Store<{ welds: WeldState }>)
  private readonly scheduling = inject(SchedulingService)
  state!: WeldState

  createVisible = false
  createdBy = '调度员甲'
  slots: DaySlot[] = ['上午', '下午', '夜间']
  methods = [{ name: 'UT 超声', code: 'UT' }, { name: 'MT 磁粉', code: 'MT' }, { name: 'PT 渗透', code: 'PT' }]
  row: BatchFormRow = { date: '2026-10-08', slot: '上午', method: 'UT', weldIdsText: 'W-104', equipmentId: 'EQ-UT-01', inspectorId: 'INSP-陈锋' }

  backfillVisible = false
  backfillPlanId = ''
  backfillOriginalMethod = ''
  backfill = { date: '2026-10-09', slot: '上午' as DaySlot, method: 'UT', equipmentId: 'EQ-UT-01', inspectorId: 'INSP-陈锋' }

  reasonVisible = false
  reason = ''
  recoverNo = 'SCH-RECOVER-1'

  constructor() { this.store.select('welds').subscribe((state) => this.state = state) }

  get equipment() { return this.state?.scheduling?.equipment ?? [] }
  get inspectors() { return this.state?.scheduling?.inspectors ?? [] }
  get retiredResults() { return this.state?.scheduling?.retiredResults ?? [] }
  get equipmentOptions() { return this.equipment.filter((e) => e.methods.includes(this.row.method)).map((e) => ({ id: e.id, name: `${e.name}（${e.id}）` })) }
  get inspectorOptions() { return this.inspectors.filter((i) => i.certs.some((c) => c.method === this.row.method)).map((i) => ({ id: i.id, name: `${i.name}（${i.id}）` })) }

  get batchRows() {
    const s = this.state?.scheduling
    if (!s) return []
    return s.plans.map((plan) => ({ plan, batchId: plan.batchId ?? '—' }))
  }

  get repairWelds() { return (this.state?.welds ?? []).filter((item) => ['返修中', '待复检'].includes(item.status)) }
  get needsMethodSplit() { return !['UT', 'MT', 'PT'].includes(this.backfillOriginalMethod) }

  latestCal(equipmentId: string) {
    const e = this.equipment.find((item) => item.id === equipmentId)
    return [...(e?.calibrations ?? [])].sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0]
  }

  severity(state: PlanState) {
    switch (state) {
      case '已完成': return 'success'
      case '执行中': return 'info'
      case '已退回重排': return 'danger'
      case '待补录': return 'warn'
      default: return 'secondary'
    }
  }

  get basisPreview() {
    const s = this.state?.scheduling
    if (!s || !this.row.date || !this.row.equipmentId || !this.row.inspectorId) return null
    const check = this.scheduling.resolveBasis({ method: this.row.method, date: this.row.date, equipmentId: this.row.equipmentId, inspectorId: this.row.inspectorId }, s)
    const conflicts = this.scheduling.conflictsOf(s, { date: this.row.date, slot: this.row.slot, equipmentId: this.row.equipmentId, inspectorId: this.row.inspectorId })
    if (!check.ok) return { ok: false, text: check.missing.map((m: { detail: string }) => m.detail).join('；') }
    if (conflicts.length) return { ok: false, text: conflicts.map((c) => `冲突：${c.date} ${c.slot} ${c.kind}「${c.resourceName}」被 ${c.planId}（${c.batchId}）占用`).join('；') }
    return { ok: true, text: `${check.basis!.equipmentName} / ${check.basis!.equipmentCert.certNo}；${check.basis!.inspectorName} / ${check.basis!.inspectorCert.certNo}` }
  }

  get canSubmit() {
    return !!this.createdBy && !!this.row.weldIdsText.trim() && !!this.basisPreview?.ok
  }

  openCreate() { this.createVisible = true }

  async doSubmit(scheduleNo?: string) {
    const weldIds = this.row.weldIdsText.split(/[，,\s]+/).filter(Boolean)
    const feedback = await this.scheduling.submit({
      scheduleNo, createdBy: this.createdBy,
      items: [{ date: this.row.date, slot: this.row.slot, method: this.row.method, weldIds, equipmentId: this.row.equipmentId, inspectorId: this.row.inspectorId }],
    })
    if (feedback.ok) this.createVisible = false
  }

  /** 并发演练：同一日期/时段/设备/人员，只放行先到者 */
  async raceSubmit(actor: string, scheduleNo: string) {
    this.createdBy = actor
    await this.scheduling.submit({
      scheduleNo, createdBy: actor,
      items: [{ date: '2026-10-08', slot: '上午', method: 'UT', weldIds: ['W-110'], equipmentId: 'EQ-UT-01', inspectorId: 'INSP-陈锋' }],
    })
  }

  /** 模拟崩溃：日志 applied=false 已写入，但占用尚未生效 */
  async crashDemo() {
    const { crashAfterJournal } = await import('../core/scheduling')
    const s = this.state.scheduling
    if (!s) return
    const entry = { seq: Date.now() % 100000, scheduleNo: 'SCH-RECOVER-1', op: '提交批次' as const, time: new Date().toISOString(), applied: false,
      payload: { createdBy: '调度员甲', items: [{ date: '2026-10-09', slot: '下午' as DaySlot, method: 'UT', weldIds: ['W-112'], equipmentId: 'EQ-UT-02', inspectorId: 'INSP-赵岚' }] } }
    this.store.dispatch(A.schedulingApplied({
      scheduling: crashAfterJournal(s, entry),
      notice: '写入失败：WAL 已记录 SCH-RECOVER-1（未应用），设备/人员未占用。请用“崩溃后恢复”重放。',
      audit: { actor: '系统', action: '写入中断', target: 'SCH-RECOVER-1', detail: '日志落盘后状态写入失败，等待按排程号恢复' },
    }))
  }

  async doRecover() { await this.scheduling.recover(this.recoverNo.trim()) }

  openBackfill(planId: string, originalMethod: string) {
    this.backfillPlanId = planId
    this.backfillOriginalMethod = originalMethod
    this.backfill = { date: '2026-10-09', slot: '上午', method: ['UT', 'MT', 'PT'].includes(originalMethod) ? originalMethod : 'UT', equipmentId: 'EQ-UT-01', inspectorId: 'INSP-陈锋' }
    this.backfillVisible = true
  }

  async doBackfill() {
    const errors = await this.scheduling.backfill(this.backfillPlanId, { ...this.backfill, method: this.needsMethodSplit ? this.backfill.method : undefined })
    if (!errors.length) this.backfillVisible = false
  }

  /** 设备校准 / 检验员资格换版：用新证书版本号触发执行前退回重排 */
  async recert(kind: '设备' | '检验员资格', resourceId: string, method: string) {
    const suffix = `${Date.now().toString().slice(-6)}`
    const cert = { certNo: `NEW-${kind === '设备' ? 'CAL' : 'CERT'}-${suffix}`, validFrom: '2026-10-02', validUntil: '2027-10-01' }
    await this.scheduling.recert({ kind, resourceId, method, cert, actor: '设备/质量管理员' })
  }

  advance(id: string, status: string) { this.store.dispatch(A.advanceWeld({ id, status: status as never })) }
}
