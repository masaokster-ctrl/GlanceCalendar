import { describe, expect, it } from 'vitest'
import { upcomingEventsReducer, initialUpcomingEventsContext, UPCOMING_EVENTS_PER_PAGE, type UpcomingEventsContext } from '../src/upcomingEventsState'
import type { DayEventItem } from '../src/dayEvents'

function events(count: number): DayEventItem[] {
  return Array.from({ length: count }, (_, i) => ({
    eventId: `k${i}`,
    title: `e${i}`,
    allDay: false,
    startLocal: '2026-07-23T09:00:00',
    endLocal: '2026-07-23T10:00:00',
    startDate: null,
    endDateExclusive: null,
  }))
}

describe('upcomingEventsReducer', () => {
  it('START moves to loading and clears prior data', () => {
    const ctx = upcomingEventsReducer(initialUpcomingEventsContext, { type: 'START' })
    expect(ctx).toEqual({ state: 'loading', events: [], truncated: false, selectedIndex: 0, errorCode: null })
  })

  it('SUCCEEDED with events moves to loaded', () => {
    const loading = upcomingEventsReducer(initialUpcomingEventsContext, { type: 'START' })
    const ctx = upcomingEventsReducer(loading, { type: 'SUCCEEDED', events: events(2), truncated: false })
    expect(ctx.state).toBe('loaded')
    expect(ctx.events).toHaveLength(2)
  })

  it('SUCCEEDED with no events moves to empty', () => {
    const loading = upcomingEventsReducer(initialUpcomingEventsContext, { type: 'START' })
    const ctx = upcomingEventsReducer(loading, { type: 'SUCCEEDED', events: [], truncated: false })
    expect(ctx.state).toBe('empty')
  })

  it('FAILED moves to error and clears events', () => {
    const loading = upcomingEventsReducer(initialUpcomingEventsContext, { type: 'START' })
    const ctx = upcomingEventsReducer(loading, { type: 'FAILED', errorCode: 'day_events_failed' })
    expect(ctx.state).toBe('error')
    expect(ctx.errorCode).toBe('day_events_failed')
  })

  it('SELECT_DOWN/SELECT_UP move within bounds and are no-ops outside loaded', () => {
    const loading = upcomingEventsReducer(initialUpcomingEventsContext, { type: 'START' })
    const loaded = upcomingEventsReducer(loading, { type: 'SUCCEEDED', events: events(5), truncated: false })

    const idx1 = upcomingEventsReducer(loaded, { type: 'SELECT_DOWN' })
    expect(idx1.selectedIndex).toBe(1)

    let clamped = loaded
    for (let i = 0; i < 10; i += 1) clamped = upcomingEventsReducer(clamped, { type: 'SELECT_DOWN' })
    expect(clamped.selectedIndex).toBe(4) // events(5) -> インデックス0..4

    const back = upcomingEventsReducer(clamped, { type: 'SELECT_UP' })
    expect(back.selectedIndex).toBe(3)

    expect(upcomingEventsReducer(loading, { type: 'SELECT_DOWN' })).toBe(loading)
  })

  it('RESET returns to the initial context', () => {
    const loading = upcomingEventsReducer(initialUpcomingEventsContext, { type: 'START' })
    const loaded = upcomingEventsReducer(loading, { type: 'SUCCEEDED', events: events(1), truncated: true })
    const reset = upcomingEventsReducer(loaded, { type: 'RESET' })
    expect(reset).toEqual(initialUpcomingEventsContext)
  })

  it('UPCOMING_EVENTS_PER_PAGE is 3', () => {
    expect(UPCOMING_EVENTS_PER_PAGE).toBe(3)
  })

  it('selectedIndex starts at 0 even with zero events', () => {
    const ctx: UpcomingEventsContext = { ...initialUpcomingEventsContext, events: [] }
    expect(ctx.selectedIndex).toBe(0)
  })
})
