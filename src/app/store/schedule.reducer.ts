import { createReducer, on } from '@ngrx/store'
import type { ScheduleBoard } from '../scheduling/domain'
import * as A from './schedule.actions'

export interface ScheduleState {
  board: ScheduleBoard | null
}

export const initialScheduleState: ScheduleState = { board: null }

export const scheduleReducer = createReducer(
  initialScheduleState,
  on(A.scheduleBoardLoaded, (state, { board }) => ({ ...state, board })),
)
