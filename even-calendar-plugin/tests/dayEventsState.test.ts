import { describe, expect, it } from 'vitest'
import { dayEventsReducer, initialDayEventsContext, DAY_EVENTS_PER_PAGE, type DayEventsContext } from '../src/dayEventsState'
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

describe('dayEventsReducer', () => {
  it('START moves to loading and clears prior data', () => {
    const ctx = dayEventsReducer(initialDayEventsContext, { type: 'START', day: 'today' })
    expect(ctx).toEqual({ state: 'loading', day: 'today', dateLocal: null, events: [], truncated: false, selectedIndex: 0, errorCode: null })
  })

  it('SUCCEEDED with events moves to loaded', () => {
    const loading = dayEventsReducer(initialDayEventsContext, { type: 'START', day: 'today' })
    const ctx = dayEventsReducer(loading, { type: 'SUCCEEDED', dateLocal: '2026-07-23', events: events(2), truncated: false })
    expect(ctx.state).toBe('loaded')
    expect(ctx.events).toHaveLength(2)
    expect(ctx.selectedIndex).toBe(0)
  })

  it('SUCCEEDED with no events moves to empty', () => {
    const loading = dayEventsReducer(initialDayEventsContext, { type: 'START', day: 'today' })
    const ctx = dayEventsReducer(loading, { type: 'SUCCEEDED', dateLocal: '2026-07-23', events: [], truncated: false })
    expect(ctx.state).toBe('empty')
  })

  it('FAILED moves to error and clears events', () => {
    const loading = dayEventsReducer(initialDayEventsContext, { type: 'START', day: 'today' })
    const ctx = dayEventsReducer(loading, { type: 'FAILED', errorCode: 'day_events_failed' })
    expect(ctx.state).toBe('error')
    expect(ctx.errorCode).toBe('day_events_failed')
    expect(ctx.events).toEqual([])
  })

  it('SELECT_DOWN/SELECT_UP move within bounds and are no-ops outside loaded', () => {
    const loading = dayEventsReducer(initialDayEventsContext, { type: 'START', day: 'today' })
    const loaded = dayEventsReducer(loading, { type: 'SUCCEEDED', dateLocal: '2026-07-23', events: events(4), truncated: false })
    expect(loaded.selectedIndex).toBe(0)

    const idx1 = dayEventsReducer(loaded, { type: 'SELECT_DOWN' })
    expect(idx1.selectedIndex).toBe(1)
    const idx3 = [idx1].reduce((ctx) => dayEventsReducer(ctx, { type: 'SELECT_DOWN' }), idx1)
    expect(idx3.selectedIndex).toBe(2)

    // 末尾(最後のイベント)でクランプされる
    let clamped = loaded
    for (let i = 0; i < 10; i += 1) clamped = dayEventsReducer(clamped, { type: 'SELECT_DOWN' })
    expect(clamped.selectedIndex).toBe(3) // events(4) -> インデックス0..3

    const back = dayEventsReducer(clamped, { type: 'SELECT_UP' })
    expect(back.selectedIndex).toBe(2)

    // 先頭でもクランプされる
    let clampedUp = loaded
    for (let i = 0; i < 5; i += 1) clampedUp = dayEventsReducer(clampedUp, { type: 'SELECT_UP' })
    expect(clampedUp.selectedIndex).toBe(0)

    // loading中は選択操作を無視する
    expect(dayEventsReducer(loading, { type: 'SELECT_DOWN' })).toBe(loading)
  })

  it('RESET returns to the initial context', () => {
    const loading = dayEventsReducer(initialDayEventsContext, { type: 'START', day: 'today' })
    const loaded = dayEventsReducer(loading, { type: 'SUCCEEDED', dateLocal: '2026-07-23', events: events(1), truncated: true })
    const reset = dayEventsReducer(loaded, { type: 'RESET' })
    expect(reset).toEqual(initialDayEventsContext)
  })

  it('DAY_EVENTS_PER_PAGE is 3', () => {
    expect(DAY_EVENTS_PER_PAGE).toBe(3)
  })

  it('selectedIndex starts at 0 even with zero events', () => {
    const ctx: DayEventsContext = { ...initialDayEventsContext, events: [] }
    expect(ctx.selectedIndex).toBe(0)
  })
})
