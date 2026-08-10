import { afterEach, describe, expect, it } from 'vitest'
import { computeEditDiff, fieldsForDiff, type EditInstructionFields } from '../src/editInstruction'
import type { EventDetail } from '../src/eventDetail'
import { resetActiveLocaleForTest, setActiveLocale } from '../src/i18n/locale'

afterEach(() => {
  resetActiveLocaleForTest()
})

function timedEvent(overrides: Partial<EventDetail> = {}): EventDetail {
  return {
    eventId: 'evt-1',
    title: '打ち合わせ',
    location: null,
    description: null,
    allDay: false,
    startLocal: '2026-09-01T10:00:00',
    endLocal: '2026-09-01T11:00:00',
    startDate: null,
    endDateExclusive: null,
    ...overrides,
  } as EventDetail
}

describe('computeEditDiff / fieldsForDiff — locale independence (回帰: labelでの判定禁止)', () => {
  const cases: Array<{ locale: 'ja' | 'en'; label: string }> = [
    { locale: 'ja', label: 'Japanese' },
    { locale: 'en', label: 'English' },
  ]

  for (const { locale, label } of cases) {
    describe(`${label} locale`, () => {
      it('selects the title field for PATCH', () => {
        setActiveLocale(locale)
        const current = timedEvent()
        const fields: EditInstructionFields = { title: '定例会議' }
        const diff = computeEditDiff(current, fields)
        expect(diff).toHaveLength(1)
        expect(diff[0]?.key).toBe('title')

        const patch = fieldsForDiff(fields, diff)
        expect(patch.title).toBe('定例会議')
      })

      it('selects the location field for PATCH', () => {
        setActiveLocale(locale)
        const current = timedEvent()
        const fields: EditInstructionFields = { location: '会議室A' }
        const diff = computeEditDiff(current, fields)
        expect(diff.map((d) => d.key)).toEqual(['location'])

        const patch = fieldsForDiff(fields, diff)
        expect(patch.location).toBe('会議室A')
      })

      it('selects the description field for PATCH', () => {
        setActiveLocale(locale)
        const current = timedEvent()
        const fields: EditInstructionFields = { description: 'agenda' }
        const diff = computeEditDiff(current, fields)
        expect(diff.map((d) => d.key)).toEqual(['description'])

        const patch = fieldsForDiff(fields, diff)
        expect(patch.description).toBe('agenda')
      })

      it('selects every timing field for PATCH when the schedule changes', () => {
        setActiveLocale(locale)
        const current = timedEvent()
        const fields: EditInstructionFields = { startLocal: '2026-09-01T14:00:00', endLocal: '2026-09-01T15:00:00' }
        const diff = computeEditDiff(current, fields)
        expect(diff.map((d) => d.key)).toEqual(['timing'])

        const patch = fieldsForDiff(fields, diff)
        expect(patch.startLocal).toBe('2026-09-01T14:00:00')
        expect(patch.endLocal).toBe('2026-09-01T15:00:00')
      })

      it('never returns an empty PATCH when a real change was requested', () => {
        setActiveLocale(locale)
        const current = timedEvent()
        const fields: EditInstructionFields = { title: 'new title', location: 'room B' }
        const diff = computeEditDiff(current, fields)
        const patch = fieldsForDiff(fields, diff)
        expect(Object.keys(patch).length).toBeGreaterThan(0)
        expect(patch.title).toBe('new title')
        expect(patch.location).toBe('room B')
      })

      it('omits fields whose value did not actually change', () => {
        setActiveLocale(locale)
        const current = timedEvent({ title: 'same' })
        const fields: EditInstructionFields = { title: 'same', location: 'room C' }
        const diff = computeEditDiff(current, fields)
        expect(diff.map((d) => d.key)).toEqual(['location'])

        const patch = fieldsForDiff(fields, diff)
        expect(patch.title).toBeUndefined()
        expect(patch.location).toBe('room C')
      })
    })
  }

  it('produces identical PATCH payloads in both locales for the same input', () => {
    const current = timedEvent()
    const fields: EditInstructionFields = { title: 'x', location: 'y', startLocal: '2026-09-01T14:00:00' }

    setActiveLocale('ja')
    const jaPatch = fieldsForDiff(fields, computeEditDiff(current, fields))

    setActiveLocale('en')
    const enPatch = fieldsForDiff(fields, computeEditDiff(current, fields))

    expect(enPatch).toEqual(jaPatch)
  })

  it('localizes the display label while keeping the key stable', () => {
    const current = timedEvent()
    const fields: EditInstructionFields = { title: 'x' }

    setActiveLocale('ja')
    const ja = computeEditDiff(current, fields)[0]
    setActiveLocale('en')
    const en = computeEditDiff(current, fields)[0]

    expect(ja?.key).toBe('title')
    expect(en?.key).toBe('title')
    expect(ja?.label).toBe('予定名')
    expect(en?.label).toBe('Title')
  })
})
