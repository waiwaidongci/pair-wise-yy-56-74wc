import type { Equipment, Inspector } from '../types'
import type { SchedulingContext, SchedulingState } from '../core/scheduling'

export const SEED_EQUIPMENT: Equipment[] = [
  {
    id: 'EQ-UT-01', name: '超声波探伤仪 A 型', model: 'HS616e', methods: ['UT'],
    calibrations: [{ certNo: 'CAL-UT01-2026-03', validFrom: '2026-03-01', validUntil: '2026-12-31' }],
  },
  {
    id: 'EQ-UT-02', name: '超声波探伤仪 B 型', model: 'HS620', methods: ['UT'],
    calibrations: [{ certNo: 'CAL-UT02-2026-01', validFrom: '2026-01-10', validUntil: '2026-10-15' }],
  },
  {
    id: 'EQ-MT-01', name: '磁粉探伤仪', model: 'CDX-III', methods: ['MT'],
    calibrations: [{ certNo: 'CAL-MT01-2026-02', validFrom: '2026-02-01', validUntil: '2026-11-30' }],
  },
  {
    id: 'EQ-PT-01', name: '渗透检测套件', model: 'PT-KIT-2', methods: ['PT'],
    calibrations: [{ certNo: 'CAL-PT01-2026-04', validFrom: '2026-04-01', validUntil: '2027-03-31' }],
  },
]

export const SEED_INSPECTORS: Inspector[] = [
  {
    id: 'INSP-陈锋', name: '陈锋',
    certs: [
      { method: 'UT', certNo: 'UT-Ⅱ-陈锋-2025', validFrom: '2025-07-01', validUntil: '2029-06-30' },
      { method: 'MT', certNo: 'MT-Ⅱ-陈锋-2025', validFrom: '2025-07-01', validUntil: '2029-06-30' },
    ],
  },
  {
    id: 'INSP-赵岚', name: '赵岚',
    certs: [
      { method: 'UT', certNo: 'UT-Ⅱ-赵岚-2024', validFrom: '2024-03-01', validUntil: '2028-02-28' },
      { method: 'PT', certNo: 'PT-Ⅱ-赵岚-2024', validFrom: '2024-03-01', validUntil: '2028-02-28' },
    ],
  },
  {
    id: 'INSP-周琪', name: '周琪',
    certs: [{ method: 'MT', certNo: 'MT-Ⅱ-周琪-2026', validFrom: '2026-01-01', validUntil: '2030-12-31' }],
  },
]

export function emptyScheduling(): SchedulingState {
  return {
    equipment: structuredClone(SEED_EQUIPMENT),
    inspectors: structuredClone(SEED_INSPECTORS),
    batches: [], plans: [], retiredResults: [], journal: [], appliedScheduleNos: [],
  }
}

let seqCounter = 100

/** 统一的时钟与流水号来源，方便测试里模拟两名调度员的先后提交 */
export function defaultContext(clock: () => string = () => new Date().toISOString()): SchedulingContext {
  return {
    now: clock(),
    seq: nextSeq,
    scheduleNo: () => `SCH-${Date.now().toString(36).toUpperCase()}-${nextSeq().toString().padStart(3, '0')}`,
  }
}

/** 跨 dispatch 稳定递增的流水号（reducer 初始化也共用） */
export function nextSeq(): number {
  return seqCounter++
}

export function resetContext(start = 100) {
  seqCounter = start
}
