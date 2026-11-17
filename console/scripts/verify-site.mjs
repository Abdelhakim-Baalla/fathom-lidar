import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const site = new URL('https://abdelhakim-baalla.github.io/fathom-lidar/')
const base = process.env.FATHOM_BASE ?? '/'
const sitemap = readFileSync(resolve(dist, 'sitemap.xml'), 'utf8')
const urls = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map(match => match[1])
const titles = new Set()
for (const url of urls) {
  assert.ok(url.startsWith(site.href), `Unexpected canonical: ${url}`)
  const path = url.slice(site.href.length) || 'index.html'
  const file = resolve(dist, path)
  const html = readFileSync(file, 'utf8')
  assert.ok(!/content="noindex/.test(html), `${path} must be indexable`)
  assert.ok(html.includes(`rel="canonical" href="${url}"`), `${path}: canonical mismatch`)
  const title = html.match(/<title>(.*?)<\/title>/)?.[1]
  assert.ok(title && !titles.has(title), `${path}: missing or duplicate title`)
  titles.add(title)
  assert.ok(html.includes('name="description"'), `${path}: missing description`)
  assert.ok(html.includes('property="og:image"'), `${path}: missing share image`)
  assert.ok(html.includes('<h1>'), `${path}: missing initial HTML heading`)
  for (const match of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) JSON.parse(match[1])
  // Every same-site resource and navigation target must exist in the Pages artifact.
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const target = match[1]
    if (/^(https?:|#|data:|mailto:)/.test(target)) continue
    const resolved = new URL(target, `https://build.invalid${base}${path === 'index.html' ? '' : path}`)
    assert.ok(resolved.pathname.startsWith(base), `${path}: asset escapes deployment base: ${target}`)
    const relative = decodeURIComponent(resolved.pathname.slice(base.length))
    const destination = resolve(dist, relative || 'index.html')
    assert.ok(existsSync(destination), `${path}: missing ${target}`)
  }
}
assert.equal(urls.length, 7)
assert.ok(readFileSync(resolve(dist, '404.html'), 'utf8').includes('content="noindex"'))
console.log(`Verified ${urls.length} indexable pages, structured data, unique titles, local links, images and 404 exclusion.`)
