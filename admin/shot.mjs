import { chromium } from 'playwright-core'
const browser = await chromium.launch({ channel: 'chrome' })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', e => errors.push('pageerror: ' + e.message))

await page.goto('http://demo.localhost:5173/login', { waitUntil: 'networkidle' })
await page.fill('input[type=email]', 'admin@acme.demo')
await page.fill('input[type=password]', 'admin12345')
await page.click('button.btn-primary')
await page.waitForURL(u => !u.pathname.includes('login'), { timeout: 20000 })
await page.waitForLoadState('networkidle')
console.log('landed on:', new URL(page.url()).pathname)
await page.screenshot({ path: 'D:/projects/hrdesktimesol/.run/01-dashboard.png' })

const links = await page.$$eval('.nav-link', els => els.map(e => e.textContent.trim()))
console.log(`nav items (${links.length}):`, links.join(' | '))

for (const [name, path] of [['attendance','/attendance'],['leave','/leave'],['approvals','/approvals'],['assets','/assets'],['onboarding','/onboarding'],['helpdesk','/helpdesk/queue']]) {
  await page.goto('http://demo.localhost:5173' + path, { waitUntil: 'networkidle' })
  await page.waitForTimeout(900)
  await page.screenshot({ path: `D:/projects/hrdesktimesol/.run/02-${name}.png` })
  const h = await page.$eval('h1, h2', e => e.textContent.trim()).catch(() => '(no heading)')
  const rows = await page.$$eval('tbody tr, .card, [class*=row]', e => e.length).catch(()=>0)
  console.log(`  ${path.padEnd(18)} "${h}"  (${rows} elements)`)
}
console.log('console errors:', errors.length ? errors.slice(0,8) : 'none')
await browser.close()
