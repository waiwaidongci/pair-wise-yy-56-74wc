import { createAction, props } from '@ngrx/store'
import type { ScheduleBoard } from '../scheduling/domain'

export const loadScheduleBoard = createAction('[Schedule] Load Board')
export const scheduleBoardLoaded = createAction('[Schedule] Board Loaded', props<{ board: ScheduleBoard }>())
