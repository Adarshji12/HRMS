/**
 * Code 128 barcodes, as SVG. Subset B covers the characters an item code or EAN carries (letters, digits,
 * punctuation); a run of digits is left in subset B, which every scanner reads.
 */

const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231',
  '113222', '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131',
  '113123', '113321', '133121', '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211',
  '241211', '221114', '413111', '241112', '134111', '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214',
  '211232', '2331112',
]
const START_B = 104
const STOP = 106

/** The bar and space widths of a value, starting with a bar. Characters outside printable ASCII are dropped. */
export function code128Widths(value: string): number[] {
  const text = [...value].filter((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) <= 126).join('')
  const codes = [START_B, ...[...text].map((c) => c.charCodeAt(0) - 32)]
  const checksum = codes.reduce((sum, code, i) => sum + code * (i === 0 ? 1 : i), 0) % 103
  const all = [...codes, checksum, STOP]
  return all.flatMap((c) => PATTERNS[c].split('').map(Number))
}

/** An SVG string for the barcode, `height` tall, each module `module` wide. */
export function code128Svg(value: string, { module = 1.4, height = 36 }: { module?: number; height?: number } = {}): string {
  const widths = code128Widths(value)
  const quiet = 10 * module
  let x = quiet
  let bars = ''
  widths.forEach((w, i) => {
    if (i % 2 === 0) bars += `<rect x="${x.toFixed(2)}" y="0" width="${(w * module).toFixed(2)}" height="${height}"/>`
    x += w * module
  })
  const total = x + quiet
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total.toFixed(2)} ${height}" width="${total.toFixed(2)}" height="${height}" preserveAspectRatio="none" shape-rendering="crispEdges" fill="#000">${bars}</svg>`
}

/* ------------------------------------------------------------------ EAN-13 */

const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011']
const EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111']
const EAN_R = EAN_L.map((p) => p.replace(/[01]/g, (c) => (c === '0' ? '1' : '0')))
const EAN_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL']

/** The 13 digits of an EAN-13 (adding the check digit to a 12-digit value), or null when the value is not one. */
export function ean13Digits(value: string): string | null {
  const v = value.trim()
  if (!/^\d{12,13}$/.test(v)) return null
  const body = v.slice(0, 12)
  const sum = [...body].reduce((s, d, i) => s + Number(d) * (i % 2 ? 3 : 1), 0)
  const check = (10 - (sum % 10)) % 10
  if (v.length === 13 && Number(v[12]) !== check) return null
  return body + check
}

/** An EAN-13 as SVG, or null when the value cannot be one. */
export function ean13Svg(value: string, { module = 1.4, height = 36 }: { module?: number; height?: number } = {}): string | null {
  const digits = ean13Digits(value)
  if (!digits) return null
  const parity = EAN_PARITY[Number(digits[0])]
  let bits = '101'
  for (let i = 0; i < 6; i++) bits += (parity[i] === 'L' ? EAN_L : EAN_G)[Number(digits[i + 1])]
  bits += '01010'
  for (let i = 0; i < 6; i++) bits += EAN_R[Number(digits[i + 7])]
  bits += '101'
  const quiet = 9 * module
  let bars = ''
  for (let i = 0; i < bits.length; ) {
    if (bits[i] === '0') { i++; continue }
    let j = i
    while (j < bits.length && bits[j] === '1') j++
    bars += `<rect x="${(quiet + i * module).toFixed(2)}" y="0" width="${((j - i) * module).toFixed(2)}" height="${height}"/>`
    i = j
  }
  const total = bits.length * module + quiet * 2
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total.toFixed(2)} ${height}" width="${total.toFixed(2)}" height="${height}" preserveAspectRatio="none" shape-rendering="crispEdges" fill="#000">${bars}</svg>`
}
