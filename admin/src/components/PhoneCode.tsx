import { useEffect } from 'react'

/**
 * A +91 on every phone or mobile number box, without touching each form.
 *
 * Numbers are kept as the ten digits people type; the code is drawn inside the box (see `.cc-in` in styles.css) so it is
 * always visible and never has to be typed. A number pasted with the code, `+91 98765 43210` or `0 98765 43210`, is cut
 * back to ten digits when the box loses focus, so the saved value stays the same shape whichever way it was entered.
 *
 * A box counts as a phone box when it is `type="tel"`, or when its own label, name, placeholder or aria-label says
 * mobile, phone, WhatsApp or contact number. Search and filter boxes are left alone.
 */

const LOOKS_LIKE_PHONE = /\b(mobile|phone|whats\s?app|contact\s*(no\b|number)|cell)\b|mobile_?no|phone_?no/i

function labelText(input: HTMLInputElement): string {
  const own = [input.name, input.id, input.getAttribute('aria-label'), input.placeholder].filter(Boolean).join(' ')
  const wrap = input.closest('label')
  // A label's own text, not the text of every other control inside a big wrapper.
  const text = wrap && wrap.querySelectorAll('input, select, textarea').length <= 2 ? (wrap.firstChild?.textContent ?? wrap.textContent ?? '') : ''
  const field = input.closest('.lf-field, .cp-f, .es-f, .hd-f, .co-field, .setting, .pr-field, .hs-field')
  const heading = field?.querySelector('.lf-label, .cp-fl, .es-fl, .hd-lab, .co-field-label, .pr-field-label, .hs-label')?.textContent ?? ''
  return `${own} ${text} ${heading}`
}

function isPhoneBox(input: HTMLInputElement): boolean {
  if (input.type === 'search' || input.type === 'email' || input.type === 'password' || input.type === 'hidden') return false
  if (input.dataset.cc !== undefined || input.readOnly && input.type !== 'tel') return false
  if (input.type === 'tel' || input.inputMode === 'tel') return true
  if (input.type !== 'text' && input.type !== '') return false
  if (/search/i.test(input.placeholder) || input.getAttribute('role') === 'searchbox') return false
  return LOOKS_LIKE_PHONE.test(labelText(input))
}

/** A box that already shows its own code (a "+91" chip beside it, or "+91" typed in the value) is not given a second one. */
function alreadyCoded(input: HTMLInputElement): boolean {
  if (/^\s*\+/.test(input.value)) return true
  // A prefix drawn as its own element (a "+91" chip, or any code next to the box) counts as already coded.
  if (input.parentElement?.querySelector('[class*="prefix"], [class*="dial"]')) return true
  const around = input.parentElement?.textContent ?? ''
  return /\+\s?91/.test(around) || /\+\s?\d{1,3}/.test(input.closest('label')?.textContent ?? '') && /\+\d/.test(around)
}

function mark(root: ParentNode) {
  // Boxes marked by an earlier pass that turn out to carry their own code lose the one drawn over it.
  root.querySelectorAll<HTMLInputElement>('input.cc-in').forEach((input) => {
    if (alreadyCoded(input)) { input.classList.remove('cc-in'); input.style.removeProperty('--cc-x'); input.style.removeProperty('--cc-pad') }
  })
  root.querySelectorAll<HTMLInputElement>('input:not([data-cc])').forEach((input) => {
    if (!isPhoneBox(input)) return
    input.dataset.cc = '91'
    const style = getComputedStyle(input)
    // Leave a box alone when it already carries a code or paints its own background image.
    if (alreadyCoded(input) || (style.backgroundImage && style.backgroundImage !== 'none')) return
    // A box with an icon drawn over its left edge already has padding to clear it: the code goes after that, not on top.
    const pl = parseFloat(style.paddingLeft) || 0
    if (pl > 20) {
      input.style.setProperty('--cc-x', `${pl}px`)
      input.style.setProperty('--cc-pad', `${pl + 36}px`)
    }
    input.classList.add('cc-in')
  })
}

/** Cuts a pasted +91 / 91 / leading 0 back to the ten digits the form stores. */
function tenDigits(value: string): string | null {
  const digits = value.replace(/\D/g, '')
  if (!/^(\+|00|0|91)/.test(value.trim()) && digits.length !== 12) return null
  const tail = digits.length === 12 && digits.startsWith('91') ? digits.slice(2)
    : digits.length === 11 && digits.startsWith('0') ? digits.slice(1)
      : digits.length === 14 && digits.startsWith('0091') ? digits.slice(4)
        : null
  return tail && tail.length === 10 ? tail : null
}

export default function PhoneCode() {
  useEffect(() => {
    mark(document)
    let pending = 0
    const observer = new MutationObserver(() => {
      // One pass per frame however many nodes a screen change adds.
      if (pending) return
      pending = requestAnimationFrame(() => { pending = 0; mark(document) })
    })
    observer.observe(document.body, { childList: true, subtree: true })

    const onBlur = (event: FocusEvent) => {
      const input = event.target
      if (!(input instanceof HTMLInputElement) || input.dataset.cc === undefined) return
      const clean = tenDigits(input.value)
      if (clean === null || clean === input.value) return
      // Through the native setter and an input event, so a controlled React field takes the change.
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setter?.call(input, clean)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    document.addEventListener('blur', onBlur, true)
    return () => { observer.disconnect(); document.removeEventListener('blur', onBlur, true); if (pending) cancelAnimationFrame(pending) }
  }, [])
  return null
}
