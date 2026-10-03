import { ApplicationConfig } from '@angular/core'
import { provideRouter } from '@angular/router'
import { provideStore } from '@ngrx/store'
import { providePrimeNG } from 'primeng/config'
import Aura from '@primeng/themes/aura'
import { provideApollo } from 'apollo-angular'
import { InMemoryCache } from '@apollo/client/core'
import { routes } from './app.routes'
import { weldReducer } from './store/weld.reducer'
import { scheduleReducer } from './store/schedule.reducer'
import { mockGraphqlLink } from './scheduling/mock-scheduler'

export const appConfig: ApplicationConfig = {
  providers: [
    provideRouter(routes),
    provideStore({ welds: weldReducer, schedule: scheduleReducer }),
    providePrimeNG({ theme: { preset: Aura, options: { darkModeSelector: false } } }),
    provideApollo(() => ({ cache: new InMemoryCache(), link: mockGraphqlLink })),
  ],
}
