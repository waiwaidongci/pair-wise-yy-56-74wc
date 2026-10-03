import { inject, Injectable } from '@angular/core'
import { Apollo, gql } from 'apollo-angular'
import { map } from 'rxjs'
import type { InspectionPlan, RetiredResultRef, Weld } from '../types'

const WELDS_QUERY = gql`query Welds { welds { id drawing component joint method welder qualification qualificationValid inspectionRatio requiredRatio status x y repairs defects { id position type length level method report } } plans { id date method weldIds inspector state } retiredResults { resultId planId batchId weldId method report outcome } }`

export interface WeldsData {
  welds: Weld[]
  plans: InspectionPlan[]
  retiredResults: RetiredResultRef[]
}

@Injectable({ providedIn: 'root' })
export class WeldGraphqlService {
  private readonly apollo = inject(Apollo)
  load() {
    return this.apollo.watchQuery<WeldsData>({ query: WELDS_QUERY, fetchPolicy: 'cache-first' }).valueChanges.pipe(map((result) => result.data))
  }
}
