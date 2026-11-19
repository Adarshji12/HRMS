/* Shared by the Branch and Location masters: the Geography lists they pick an
 * address from, and the small pieces both pages repeat. Addresses are stored as
 * the picked names, so a record keeps reading correctly if a master is renamed. */

import { useQuery } from '../../lib/useQuery'
import { crm, type CityRow, type Country, type Master, type StateRow } from '../crm/api'
import { Field } from '../crm/parts'

export interface DistrictRow extends Master {
  state_id: string
}

/** The active countries, states, districts and cities of the Geography master. */
export function useGeoMasters() {
  const countries = useQuery<Country[]>('geo-countries', () => crm.masters<Country>('countries'))
  const states = useQuery<StateRow[]>('geo-states', () => crm.masters<StateRow>('states'))
  const districts = useQuery<DistrictRow[]>('geo-districts', () => crm.masters<DistrictRow>('districts'))
  const cities = useQuery<CityRow[]>('geo-cities', () => crm.masters<CityRow>('cities'))
  const live = <T extends { is_active: boolean }>(rows: T[] | null | undefined) => (rows ?? []).filter((r) => r.is_active)
  return {
    countries: live(countries.data),
    states: live(states.data),
    districts: live(districts.data),
    cities: live(cities.data),
  }
}

export type Geo = ReturnType<typeof useGeoMasters>

export interface Place {
  country: string
  state: string
  district: string
  city: string
}

/** What the lists below a chosen state or district hold, by name. */
export function placeOptions(geo: Geo, place: Place) {
  const country = geo.countries.find((c) => c.name === place.country)
  const states = country ? geo.states.filter((s) => s.country_id === country.id) : geo.states
  const state = geo.states.find((s) => s.name === place.state && (!country || s.country_id === country.id))
  const districts = state ? geo.districts.filter((d) => d.state_id === state.id) : []
  const district = districts.find((d) => d.name === place.district)
  const cities = state
    ? geo.cities.filter((c) => c.state_id === state.id && (!district || !('district_id' in c) || !(c as { district_id?: string | null }).district_id || (c as { district_id?: string | null }).district_id === district.id))
    : []
  return { states, districts, cities, state }
}

/** One select over a list of names. Keeps a value typed before the master had it, so an
 *  old record never blanks. */
export function NameSelect({
  label, value, options, onChange, placeholder, disabled, wide,
}: {
  label: string
  value: string
  options: string[]
  onChange: (value: string) => void
  placeholder: string
  disabled?: boolean
  wide?: boolean
}) {
  const known = options.includes(value)
  return (
    <Field label={label} wide={wide}>
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
        <option value="">{placeholder}</option>
        {value && !known && <option value={value}>{value}</option>}
        {options.map((name) => <option key={name} value={name}>{name}</option>)}
      </select>
    </Field>
  )
}
