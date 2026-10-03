# 钢结构焊缝台账、无损检测和返修闭环平台

源提示词编号：13。覆盖构件与图纸焊缝台账、二维定位、焊工资质和检测比例预警、批量检测计划、缺陷记录、返修/复检状态、Apollo GraphQL 数据层、版本快照、签字锁定和完整追溯。

## 检测排程批次（设备台账 × 检验员资格 × 检测计划）

三者通过 `src/app/core/scheduling.ts` 接成一个排程批次，纯函数可独立测试：

- **建计划即预占**：按「检测方法 + 日期 + 时段（上午/下午/夜间）」为每项计划锁定一台设备的校准证书版本和一名检验员的资格证书版本（`PlanBasis`）；当日无有效证书或设备不支持该方法，直接拒绝放行。
- **并发先到先得**：两名调度员提交同一时段，只放行先到一笔；后到者拿到 `OccupancySource`（占用计划号、批次、设备/人员名），界面明确展示占用来源。
- **证书换版退回**：计划执行前任一设备校准证或检验员资格证换版（新证书编号入册、旧版本保留可追溯），命中的计划标记「已退回重排」并记录原因、释放占用；**同批次未受影响的计划保留**，批次不整批作废，可在原时段重新派单。
- **WAL 恢复**：提交先写 `WriteJournalEntry`（applied=false）再占用。写入崩溃后按**排程号** `recoverByScheduleNo` 恢复；同一排程号重放幂等，绝不二次占用。
- **旧数据兼容升级**：历史计划缺少设备或资格版本时，不丢弃、不伪装可执行，先升级进批次并标记「待补录」（`upgradeLegacyPlans`）；补录设备/人员/时段（旧的组合方法可拆成单一持证方法）后回到待执行；**原焊缝结果归档为 `RetiredResultRef`，仍可按焊缝查询**。
- **锁定前逐项确认**：`lockBatches` 对批次内每项计划核对当日有效的设备与人员依据，任一为待补录/已退回重排/证书失效，整批拒绝签字；锁定时设备校准与资格版本逐项留痕。

代码位置：

- `src/app/core/scheduling.ts`：排程域纯函数（占用、冲突、换版退回、补录、锁定、WAL 恢复）
- `src/app/core/scheduling-seed.ts`：设备台账 / 检验员资格种子数据、时钟与流水号
- `src/app/services/scheduling.service.ts`：门面，算好下一状态后一次性提交 NgRx
- `src/app/store/weld.reducer.ts`：`scheduling` 状态与审计留痕
- 页面：检测返修页（建批、换版、崩溃恢复演练、补录）、审核锁定页（逐项依据核对）

## 技术栈

Angular、PrimeNG、NgRx、Angular Router、RxJS、Apollo Angular、GraphQL、TypeScript。

## 运行

```bash
npm install
npm run dev
```

开发地址：http://localhost:62056

```bash
npm run build   # AOT 生产构建
npm test        # 排程核心域 12 项规则测试（node --test + tsx）
```
