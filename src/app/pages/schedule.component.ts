import { Component, OnInit, inject } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { Store } from '@ngrx/store'
import { TableModule } from 'primeng/table'
import { TagModule } from 'primeng/tag'
import { ButtonModule } from 'primeng/button'
import { DialogModule } from 'primeng/dialog'
import { InputTextModule } from 'primeng/inputtext'
import { SelectModule } from 'primeng/select'
import { CheckboxModule } from 'primeng/checkbox'
import { ScheduleState } from '../store/schedule.reducer'
import { ScheduleService } from '../services/schedule.service'
import type { ActionResult, Method, SchedulePlan, SlotPeriod } from '../scheduling/domain'

const genScheduleNo = () => `SCH-${Date.now().toString(36)}-${Math.floor(Math.random() * 900 + 100)}`

@Component({
  selector:'app-schedule', standalone:true,
  imports:[CommonModule,FormsModule,TableModule,TagModule,ButtonModule,DialogModule,InputTextModule,SelectModule,CheckboxModule],
  template:`
    <main class="page">
      <div class="page-head">
        <div>
          <p class="eyebrow">设备台账 · 检验员资格 · 检测计划一体化排程</p>
          <h1>排程批次与资源预占</h1>
          <p>建计划时按方法、日期、时段预占设备与人员并固化证书版本；证书换版只退回受影响计划；锁定前逐项确认可用依据。</p>
        </div>
        <div class="head-actions">
          <p-checkbox [(ngModel)]="simulateFailure" binary="true" label="模拟写入失败（按排程号恢复）" />
          <p-button label="模拟两名调度员同时提交同一时段" icon="pi pi-users" severity="secondary" (onClick)="submitConcurrent()" />
          <p-button label="新建排程批次" icon="pi pi-plus" (onClick)="openCreate()" />
        </div>
      </div>

      <!-- 结果反馈：成功 / 占用来源 / 写入失败恢复 / 锁定阻塞 -->
      <div class="result-stack" *ngIf="results.length">
        <div class="result" *ngFor="let r of results; let i = index" [class.ok]="r.ok" [class.conflict]="!r.ok && !r.networkError && r.kind !== 'lock'" [class.err]="!r.ok && (r.networkError || r.kind === 'lock')">
          <div class="result-head">
            <b>{{ r.ok ? '✔ ' : '✘ ' }}{{ r.message }}</b>
            <small *ngIf="r.scheduleNo">排程号 {{ r.scheduleNo }}<ng-container *ngIf="r.replayed"> · 重放命中已有结果，未重复占用</ng-container></small>
          </div>
          <div class="result-body" *ngIf="!r.ok">
            <ng-container *ngIf="r.occupiedBy">
              <p>占用来源：<b>{{ r.occupiedBy.planId }}</b>（排程号 {{ r.occupiedBy.scheduleNo }}）已预占该时段{{ r.occupiedBy.resourceType }}：{{ r.occupiedBy.resourceLabel }}。先到先得，后到批次请更换时段或资源。</p>
            </ng-container>
            <ng-container *ngIf="r.affected?.length">
              <p>受影响计划（{{ r.affected!.length }}）：<b *ngFor="let a of r.affected" class="affected">{{ a.id }}（{{ a.scheduleNo }}）</b> 已退回重排；未受影响批次保留原预占。</p>
            </ng-container>
            <ng-container *ngIf="r.blockers?.length">
              <p>锁定阻塞 {{ r.blockers!.length }} 项：</p>
              <ul><li *ngFor="let b of r.blockers">{{ b.planId }}（{{ b.scheduleNo }}）：{{ b.reason }}</li></ul>
            </ng-container>
            <div class="recover" *ngIf="r.networkError && pendingInput">
              <p>未收到服务端确认，服务端可能已预占。按排程号 <b>{{ pendingInput.scheduleNo }}</b> 恢复提交：</p>
              <p-button label="按排程号恢复（不重复占用）" icon="pi pi-replay" size="small" (onClick)="recover()" />
            </div>
          </div>
        </div>
      </div>

      <div class="grid-2">
        <section class="card">
          <h2 class="panel-title">设备台账与校准证书</h2>
          <p-table [value]="board?.equipment ?? []" [paginator]="true" [rows]="4">
            <ng-template #header><tr><th>设备编号</th><th>名称</th><th>方法</th><th>校准证书</th><th>证书版本</th><th>有效期至</th><th>状态</th><th></th></tr></ng-template>
            <ng-template #body let-e>
              <tr><td><b>{{ e.id }}</b></td><td>{{ e.name }}</td><td>{{ e.method }}</td><td>{{ e.calibrationCertNo }}</td>
              <td>v{{ e.calibrationCertVersion }}</td><td>{{ e.calibrationValidUntil }}</td>
              <td><p-tag [value]="e.status" [severity]="e.status === '可用' ? 'success' : 'danger'" /></td>
              <td><p-button label="换证" icon="pi pi-refresh" size="small" [text]="true" (onClick)="renewEquipment(e.id)" /></td></tr>
            </ng-template>
          </p-table>
        </section>
        <section class="card">
          <h2 class="panel-title">检验员资格证书</h2>
          <p-table [value]="board?.inspectors ?? []" [paginator]="true" [rows]="4">
            <ng-template #header><tr><th>人员</th><th>资格方法</th><th>资格证书</th><th>证书版本</th><th>有效期至</th><th></th></tr></ng-template>
            <ng-template #body let-i>
              <tr><td><b>{{ i.name }}</b><small class="block">{{ i.id }}</small></td><td><span *ngFor="let m of i.methods" class="method-tag">{{ m }}</span></td>
              <td>{{ i.certNo }}</td><td>v{{ i.certVersion }}</td><td>{{ i.certValidUntil }}</td>
              <td><p-button label="换证" icon="pi pi-refresh" size="small" [text]="true" (onClick)="renewInspector(i.id)" /></td></tr>
            </ng-template>
          </p-table>
        </section>
      </div>

      <section class="card mt-4">
        <div class="plan-head">
          <h2 class="panel-title">排程批次（预占设备与人员，标注证书版本依据）</h2>
          <p-button [label]="board?.locked ? '已签字锁定' : '锁定前校验并排定'" icon="pi pi-lock" [disabled]="board?.locked" (onClick)="lock()" />
        </div>
        <p-table [value]="board?.plans ?? []" [paginator]="true" [rows]="6">
          <ng-template #header><tr><th>计划编号</th><th>排程号</th><th>日期 / 时段</th><th>方法</th><th>焊缝</th><th>预占设备（校准证书）</th><th>预占人员（资格证书）</th><th>状态</th><th>操作</th></tr></ng-template>
          <ng-template #body let-p>
            <tr>
              <td><b>{{ p.id }}</b><small class="block" *ngIf="p.legacy">旧计划 · 待补录</small></td>
              <td>{{ p.scheduleNo }}</td>
              <td>{{ p.date }}<small class="block">{{ p.period }}</small></td>
              <td>{{ p.method }}</td>
              <td>{{ p.weldIds.length }} 条</td>
              <td><span *ngIf="p.equipmentId">{{ p.equipmentId }}<small class="block">校准证书 v{{ p.equipmentCertVersion }}</small></span><span *ngIf="!p.equipmentId" class="muted">—</span></td>
              <td><span *ngIf="p.inspectorId">{{ p.inspector }}<small class="block">资格证书 v{{ p.inspectorCertVersion }}</small></span><span *ngIf="!p.inspectorId" class="muted">—</span></td>
              <td><p-tag [value]="p.state" [severity]="stateSeverity(p.state)" /></td>
              <td>
                <p-button *ngIf="p.state === '待重排'" label="重排" icon="pi pi-replay" size="small" (onClick)="openReschedule(p)" />
                <p-button *ngIf="p.state === '待补录'" label="补录依据" icon="pi pi-pencil" size="small" (onClick)="openSupplement(p)" />
                <span *ngIf="p.state !== '待重排' && p.state !== '待补录'" class="muted">—</span>
              </td>
            </tr>
          </ng-template>
        </p-table>
      </section>

      <section class="card mt-4">
        <h2 class="panel-title">预占记录（按方法 · 日期 · 时段）</h2>
        <p-table [value]="board?.reservations ?? []" [paginator]="true" [rows]="5">
          <ng-template #header><tr><th>预占编号</th><th>排程号</th><th>日期 / 时段</th><th>方法</th><th>设备</th><th>人员</th><th>依据版本</th><th>状态</th></tr></ng-template>
          <ng-template #body let-r>
            <tr><td>{{ r.id }}</td><td>{{ r.scheduleNo }}</td><td>{{ r.slotDate }} · {{ r.slotPeriod }}</td><td>{{ r.method }}</td>
            <td>{{ r.equipmentId }}</td><td>{{ r.inspectorId }}</td>
            <td><small>设备 v{{ r.equipmentCertVersion }} / 人员 v{{ r.inspectorCertVersion }}</small></td>
            <td><p-tag [value]="r.state" [severity]="r.state === '有效' ? 'success' : 'danger'" /></td></tr>
          </ng-template>
        </p-table>
      </section>

      <section class="card mt-4">
        <h2 class="panel-title">排程审计时间线</h2>
        <div class="audit" *ngFor="let a of board?.audit ?? []"><div><b>{{ a.actor }} · {{ a.action }}</b><span>{{ a.time }}</span></div><p><strong>{{ a.target }}</strong> {{ a.detail }}</p></div>
      </section>

      <!-- 新建排程 -->
      <p-dialog header="新建排程批次（预占设备与人员）" [(visible)]="dialog" [modal]="true" [style]="{width:'620px'}">
        <div class="form">
          <label>检测方法</label>
          <p-select [options]="methodOptions" [(ngModel)]="form.method" optionLabel="label" optionValue="value" />
          <label>计划日期</label>
          <input type="date" [(ngModel)]="form.date" />
          <label>时段</label>
          <p-select [options]="periodOptions" [(ngModel)]="form.period" optionLabel="label" optionValue="value" />
          <label>焊缝编号（逗号分隔）</label>
          <input pInputText [(ngModel)]="form.weldIds" />
          <label>预占设备（按方法自动筛选校准有效设备）</label>
          <p-select [options]="equipmentOptions" [(ngModel)]="form.equipmentId" optionLabel="label" optionValue="value" placeholder="自动选择可用设备" [showClear]="true" />
          <label>预占人员（按方法自动筛选持有效资格）</label>
          <p-select [options]="inspectorOptions" [(ngModel)]="form.inspectorId" optionLabel="label" optionValue="value" placeholder="自动选择具备资格人员" [showClear]="true" />
          <p class="hint">提交即按方法、日期、时段预占设备与人员，并固化双方证书版本；同一时段先到先得。</p>
        </div>
        <ng-template #footer>
          <p-button label="取消" severity="secondary" (onClick)="dialog = false" />
          <p-button label="提交预占" icon="pi pi-check" (onClick)="submitCreate()" />
        </ng-template>
      </p-dialog>

      <!-- 重排 -->
      <p-dialog header="计划重排（证书换版后）" [(visible)]="rescheduleDialog" [modal]="true" [style]="{width:'560px'}">
        <div class="form" *ngIf="rescheduleForm.planId">
          <p>计划 <b>{{ rescheduleForm.planId }}</b> 原预占依据已失效，请重新选择时段与资源：</p>
          <label>计划日期</label><input type="date" [(ngModel)]="rescheduleForm.date" />
          <label>时段</label><p-select [options]="periodOptions" [(ngModel)]="rescheduleForm.period" optionLabel="label" optionValue="value" />
          <label>设备</label><p-select [options]="equipmentOptionsOf(rescheduleMethod)" [(ngModel)]="rescheduleForm.equipmentId" optionLabel="label" optionValue="value" placeholder="选择可用设备" />
          <label>人员</label><p-select [options]="inspectorOptionsOf(rescheduleMethod)" [(ngModel)]="rescheduleForm.inspectorId" optionLabel="label" optionValue="value" placeholder="选择具备资格人员" />
        </div>
        <ng-template #footer>
          <p-button label="取消" severity="secondary" (onClick)="rescheduleDialog = false" />
          <p-button label="确认重排" icon="pi pi-check" (onClick)="submitReschedule()" />
        </ng-template>
      </p-dialog>

      <!-- 补录 -->
      <p-dialog header="旧计划补录（补齐设备与资格版本）" [(visible)]="supplementDialog" [modal]="true" [style]="{width:'560px'}">
        <div class="form" *ngIf="supplementForm.planId">
          <p>计划 <b>{{ supplementForm.planId }}</b> 为兼容升级的旧计划，缺少设备与资格版本依据；补录不影响原焊缝检测结果。</p>
          <label>设备</label><p-select [options]="equipmentOptionsOf(supplementMethod)" [(ngModel)]="supplementForm.equipmentId" optionLabel="label" optionValue="value" placeholder="选择可用设备" />
          <label>人员</label><p-select [options]="inspectorOptionsOf(supplementMethod)" [(ngModel)]="supplementForm.inspectorId" optionLabel="label" optionValue="value" placeholder="选择具备资格人员" />
        </div>
        <ng-template #footer>
          <p-button label="取消" severity="secondary" (onClick)="supplementDialog = false" />
          <p-button label="确认补录" icon="pi pi-check" (onClick)="submitSupplement()" />
        </ng-template>
      </p-dialog>
    </main>
  `,
  styles:[
    '.page-head{display:flex;justify-content:space-between;gap:18px;align-items:flex-start;margin-bottom:18px}.head-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap}',
    '.result-stack{display:grid;gap:10px;margin-bottom:16px}.result{border:1px solid #e1e7ef;border-left:4px solid #d97706;border-radius:8px;padding:12px 14px;background:#fff}.result.ok{border-left-color:#16a34a}.result.conflict{border-left-color:#dc2626}.result.err{border-left-color:#dc2626}.result-head{display:flex;justify-content:space-between;gap:10px;align-items:baseline}.result-head small{color:#7a8798}.result-body{margin-top:6px;font-size:13px}.result-body p{margin:4px 0}.result-body ul{margin:4px 0;padding-left:20px}.affected{display:inline-block;margin-right:8px}.recover{margin-top:8px;padding:8px;background:#f8fafc;border-radius:6px}.recover .p-button{margin-top:4px}',
    '.plan-head{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:14px}.method-tag{display:inline-block;background:#eef2ff;color:#3730a3;border-radius:4px;padding:1px 7px;margin-right:4px;font-size:12px}.block{display:block;color:#7a8798;margin-top:2px}.muted{color:#9aa5b1}.mt-4{margin-top:16px}',
    '.audit{padding:10px 0;border-bottom:1px solid #edf0f5}.audit>div{display:flex;justify-content:space-between}.audit span{color:#7a8798;font-size:12px}.audit p{margin:4px 0 0;font-size:13px}',
    '.form{display:grid;gap:9px}.form input,.form select{padding:9px;border:1px solid #cbd5e1;border-radius:6px;width:100%}.hint{color:#7a8798;font-size:12px;margin:0}',
    '@media(max-width:900px){.page-head{flex-direction:column}.plan-head{flex-direction:column;align-items:stretch}}',
  ],
})
export class ScheduleComponent implements OnInit {
  private readonly store = inject(Store<{ schedule: ScheduleState }>)
  private readonly api = inject(ScheduleService)
  state!: ScheduleState

  results: ActionResult[] = []
  dialog = false
  rescheduleDialog = false
  supplementDialog = false
  simulateFailure = false

  form = { method:'UT' as Method, date:'2026-10-09', period:'上午' as SlotPeriod, weldIds:'W-105,W-106', equipmentId:'', inspectorId:'' }
  rescheduleForm = { planId:'', date:'', period:'上午' as SlotPeriod, equipmentId:'', inspectorId:'' }
  supplementForm = { planId:'', equipmentId:'', inspectorId:'' }

  // 写入失败后保留的提交上下文（按排程号恢复）
  pendingInput: { input: { method: Method; date: string; period: SlotPeriod; weldIds: string[]; equipmentId?: string; inspectorId?: string }; scheduleNo: string } | null = null

  readonly methodOptions = [
    { label:'UT 超声检测', value:'UT' },
    { label:'MT 磁粉检测', value:'MT' },
    { label:'PT 渗透检测', value:'PT' },
  ]
  readonly periodOptions = [
    { label:'上午', value:'上午' },
    { label:'下午', value:'下午' },
  ]

  ngOnInit() {
    this.store.select('schedule').subscribe((s) => this.state = s)
    this.api.loadBoard()
  }

  get board() { return this.state?.board }

  equipmentOptionsOf(method: Method) {
    return (this.board?.equipment ?? []).filter((e) => e.method === method && e.status === '可用')
      .map((e) => ({ label:`${e.id} · ${e.name}（校准证书 v${e.calibrationCertVersion}）`, value:e.id }))
  }
  inspectorOptionsOf(method: Method) {
    return (this.board?.inspectors ?? []).filter((i) => i.methods.includes(method))
      .map((i) => ({ label:`${i.id} · ${i.name}（资格证书 v${i.certVersion}）`, value:i.id }))
  }
  get equipmentOptions() { return this.equipmentOptionsOf(this.form.method) }
  get inspectorOptions() { return this.inspectorOptionsOf(this.form.method) }
  get rescheduleMethod(): Method { return this.board?.plans.find((p: SchedulePlan) => p.id === this.rescheduleForm.planId)?.method ?? 'UT' }
  get supplementMethod(): Method { return this.board?.plans.find((p: SchedulePlan) => p.id === this.supplementForm.planId)?.method ?? 'UT' }

  stateSeverity(s: string) {
    if (s === '已完成') return 'success'
    if (s === '待重排' || s === '待补录') return 'danger'
    if (s === '执行中') return 'info'
    return 'warn'
  }

  openCreate() { this.dialog = true }

  submitCreate() {
    const input = {
      method: this.form.method,
      date: this.form.date,
      period: this.form.period,
      weldIds: this.form.weldIds.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      equipmentId: this.form.equipmentId || undefined,
      inspectorId: this.form.inspectorId || undefined,
    }
    // 排程号：失败恢复时复用同一排程号，重放不重复占用
    const scheduleNo = this.pendingInput?.scheduleNo ?? genScheduleNo()
    this.pendingInput = { input, scheduleNo }
    this.api.createBatch(input, scheduleNo, '调度员 A', this.simulateFailure).subscribe((r) => {
      this.results.unshift(r)
      if (!r.networkError) this.api.loadBoard()
      if (r.ok) {
        this.dialog = false
        this.pendingInput = null
        this.simulateFailure = false
      }
    })
  }

  // 写入失败后按排程号恢复：同一排程号重放，服务端命中已有预占
  recover() {
    if (!this.pendingInput) return
    const { input, scheduleNo } = this.pendingInput
    this.api.createBatch(input, scheduleNo, '调度员 A', false).subscribe((r) => {
      this.results.unshift(r)
      this.api.loadBoard()
      if (r.ok) {
        this.dialog = false
        this.pendingInput = null
        this.simulateFailure = false
      }
    })
  }

  // 两名调度员同时提交同一时段：串行队列按到达顺序放行先到一笔，后到者见占用来源
  submitConcurrent() {
    const base = { method:'UT' as Method, date:'2026-10-12', period:'上午' as SlotPeriod, weldIds:['W-105','W-106'], equipmentId:'EQ-UT-01', inspectorId:'I-01' }
    const noA = genScheduleNo()
    const noB = genScheduleNo()
    this.api.createBatch(base, noA, '调度员 A', false).subscribe((r) => { this.results.unshift(r); this.api.loadBoard() })
    this.api.createBatch(base, noB, '调度员 B', false).subscribe((r) => { this.results.unshift(r); this.api.loadBoard() })
  }

  renewEquipment(id: string) {
    this.api.renewCertificate('equipment', id, '调度员 A').subscribe((r) => { this.results.unshift(r); this.api.loadBoard() })
  }
  renewInspector(id: string) {
    this.api.renewCertificate('inspector', id, '调度员 A').subscribe((r) => { this.results.unshift(r); this.api.loadBoard() })
  }

  openReschedule(p: SchedulePlan) {
    this.rescheduleForm = { planId:p.id, date:p.date, period:p.period, equipmentId:p.equipmentId ?? '', inspectorId:p.inspectorId }
    this.rescheduleDialog = true
  }
  submitReschedule() {
    const input = { date:this.rescheduleForm.date, period:this.rescheduleForm.period, equipmentId:this.rescheduleForm.equipmentId, inspectorId:this.rescheduleForm.inspectorId }
    this.api.reschedule(this.rescheduleForm.planId, input, '调度员 A').subscribe((r) => {
      this.results.unshift(r)
      this.api.loadBoard()
      if (r.ok) this.rescheduleDialog = false
    })
  }

  openSupplement(p: SchedulePlan) {
    this.supplementForm = { planId:p.id, equipmentId:'', inspectorId:'' }
    this.supplementDialog = true
  }
  submitSupplement() {
    this.api.supplement(this.supplementForm.planId, this.supplementForm.equipmentId, this.supplementForm.inspectorId, '调度员 A').subscribe((r) => {
      this.results.unshift(r)
      this.api.loadBoard()
      if (r.ok) this.supplementDialog = false
    })
  }

  lock() {
    this.api.validateAndLock('质量负责人').subscribe((r) => { this.results.unshift(r); this.api.loadBoard() })
  }
}
