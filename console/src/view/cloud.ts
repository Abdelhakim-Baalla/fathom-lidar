import * as THREE from 'three'
import type { Track } from '../perception/track'
import type { Frame } from '../protocol/frame'
import { buildRamp, HEIGHT_MAX, PALETTES, type ColorMode, type PaletteId } from './palettes'

THREE.ColorManagement.enabled = false

const CAPACITY = 1_600_000
const MAX_TRACKS = 96
const CONTOUR_STEP = 20
const MODE_INDEX: Record<ColorMode, number> = { range: 0, intensity: 1, height: 2, ring: 3, truth: 4 }

const VERT = /* glsl */ `
attribute vec4 aMeta;   // intensity 0..255, ring, range in metres, capture time in seconds
attribute float aLabel;
uniform sampler2D uRamp;
uniform vec3 uWater;
uniform float uNow, uPersist, uSize, uPx, uMaxRange, uGround, uHeightMax;
uniform int uMode;
varying vec3 vColor;
void main() {
  float age = uNow - aMeta.w;
  if (age > uPersist || age < -0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float t;
  if (uMode == 0) t = aMeta.z / uMaxRange;
  else if (uMode == 1) t = aMeta.x <= 100.0 ? aMeta.x / 100.0 * 0.8 : 0.8 + (aMeta.x - 100.0) / 155.0 * 0.2;
  else if (uMode == 2) t = (position.z - uGround) / uHeightMax;
  else if (uMode == 3) t = mod(aMeta.y, 2.0) < 0.5 ? 0.25 : 0.75;
  else t = (aLabel * 16.0 + 8.0) / 255.0;
  vec3 c = texture2D(uRamp, vec2(clamp(t, 0.002, 0.998), 0.5)).rgb;
  // Old returns sink back into the water instead of popping out.
  vColor = mix(c, uWater, smoothstep(0.55, 1.0, age / uPersist) * 0.8);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_PointSize = uSize * uPx * clamp(42.0 / max(-mv.z, 1.0), 0.6, 2.4);
}`

const FRAG = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  if (dot(c, c) > 0.25) discard;
  gl_FragColor = vec4(vColor, 1.0);
}`

export type CameraPreset = 'chase' | 'chart' | 'side'

const PRESET_GOALS: Record<CameraPreset, { theta: number; phi: number; dist: number; headingUp: boolean }> = {
  chase: { theta: 0, phi: 1.02, dist: 58, headingUp: true },
  chart: { theta: 0, phi: 0.03, dist: 150, headingUp: false },
  side: { theta: 1.2, phi: 1.32, dist: 70, headingUp: true },
}

export interface Layers {
  contours: boolean
  tracks: boolean
  sweep: boolean
  outline: boolean
}

/** WebGL view of the point cloud with chart overlays. Owns its canvas and a DOM label layer. */
export class CloudView {
  onSelect: (id: number | null) => void = () => {}
  pointsHeld = 0

  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(42, 1, 0.5, 900)
  private labels: HTMLElement
  private host: HTMLElement

  private positions = new Float32Array(CAPACITY * 3)
  private meta = new Float32Array(CAPACITY * 4)
  private label = new Float32Array(CAPACITY)
  private aPos: THREE.BufferAttribute
  private aMeta: THREE.BufferAttribute
  private aLabel: THREE.BufferAttribute
  private geometry = new THREE.BufferGeometry()
  private material: THREE.ShaderMaterial
  private rampTex: THREE.DataTexture
  private write = 0

  private palette: PaletteId = 'day'
  private mode: ColorMode = 'range'
  private layers: Layers = { contours: true, tracks: true, sweep: true, outline: false }
  private maxRange = 120

  private chart = new THREE.Group() // follows the ego, north up
  private tintGroup = new THREE.Group()
  private contourGroup = new THREE.Group()
  private egoMark: THREE.LineLoop
  private sweep: THREE.Line
  private outline: THREE.LineSegments
  private boxes: THREE.LineSegments
  private boxPositions = new Float32Array(MAX_TRACKS * 30 * 3)
  private selection: THREE.Mesh

  private ego = { x: 3, y: 10, yaw: Math.PI / 2, z: 1.9 }
  private ground = 0
  private sweepAz = 0
  private now = 0
  private stampWall = 0
  private running = true

  private tracks: Track[] = []
  private tracksTime = 0
  private selected: number | null = null

  private rig = { theta: 0, phi: 1.02, dist: 58, yaw: Math.PI / 2 }
  private goal = { ...PRESET_GOALS.chase }
  private target = new THREE.Vector3(3, 10, 0)
  private raf = 0
  private lastFrame = performance.now()
  private observer: ResizeObserver
  private pool: HTMLElement[] = []
  private used = 0
  private v = new THREE.Vector3()
  private reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

  constructor(canvas: HTMLCanvasElement, labels: HTMLElement) {
    this.host = canvas.parentElement!
    this.labels = labels
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    this.camera.up.set(0, 0, 1)

    this.aPos = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage)
    this.aMeta = new THREE.BufferAttribute(this.meta, 4).setUsage(THREE.DynamicDrawUsage)
    this.aLabel = new THREE.BufferAttribute(this.label, 1).setUsage(THREE.DynamicDrawUsage)
    this.geometry.setAttribute('position', this.aPos)
    this.geometry.setAttribute('aMeta', this.aMeta)
    this.geometry.setAttribute('aLabel', this.aLabel)
    this.geometry.setDrawRange(0, 0)
    this.rampTex = new THREE.DataTexture(new Uint8Array(256 * 4), 256, 1, THREE.RGBAFormat)
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uRamp: { value: this.rampTex },
        uWater: { value: new THREE.Color() },
        uNow: { value: 0 },
        uPersist: { value: 0.3 },
        uSize: { value: 2.2 },
        uPx: { value: this.renderer.getPixelRatio() },
        uMaxRange: { value: 120 },
        uGround: { value: 0 },
        uHeightMax: { value: HEIGHT_MAX },
        uMode: { value: 0 },
      },
    })
    const cloud = new THREE.Points(this.geometry, this.material)
    cloud.frustumCulled = false
    this.scene.add(cloud)

    const line = () => new THREE.LineBasicMaterial({ transparent: true })
    this.egoMark = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(
        [[2.7, 0], [1.5, 0.95], [-2.1, 0.95], [-2.1, -0.95], [1.5, -0.95]].map(([x, y]) => new THREE.Vector3(x, y, 0.04)),
      ),
      line(),
    )
    this.sweep = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)]),
      line(),
    )
    this.outline = new THREE.LineSegments(new THREE.BufferGeometry(), line())
    this.outline.frustumCulled = false
    const boxGeo = new THREE.BufferGeometry()
    boxGeo.setAttribute('position', new THREE.BufferAttribute(this.boxPositions, 3).setUsage(THREE.DynamicDrawUsage))
    boxGeo.setDrawRange(0, 0)
    this.boxes = new THREE.LineSegments(boxGeo, line())
    this.boxes.frustumCulled = false
    this.selection = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.16, depthWrite: false }),
    )
    this.selection.visible = false
    this.chart.add(this.tintGroup, this.contourGroup)
    this.scene.add(this.chart, this.egoMark, this.sweep, this.outline, this.boxes, this.selection)

    this.setPalette('day')
    this.rebuildChart()
    this.bindPointer(canvas)
    this.observer = new ResizeObserver(() => this.resize())
    this.observer.observe(this.host)
    this.resize()
    this.raf = requestAnimationFrame(this.frame)
  }

  dispose(): void {
    cancelAnimationFrame(this.raf)
    this.observer.disconnect()
    this.renderer.dispose()
    this.geometry.dispose()
    this.material.dispose()
    this.labels.replaceChildren()
  }

  // ── Data ────────────────────────────────────────────────────────────────

  /** Append a frame's points, transformed into the odometry frame. */
  push(f: Frame, truth: Uint8Array | null): void {
    const c = Math.cos(f.yaw), s = Math.sin(f.yaw)
    const n = f.pointCount
    const start = this.write
    let w = this.write
    for (let i = 0; i < n; i++) {
      const x = f.f32[i * 4], y = f.f32[i * 4 + 1], z = f.f32[i * 4 + 2]
      this.positions[w * 3] = f.x + c * x - s * y
      this.positions[w * 3 + 1] = f.y + s * x + c * y
      this.positions[w * 3 + 2] = f.z + z
      this.meta[w * 4] = f.u8[i * 16 + 12]
      this.meta[w * 4 + 1] = f.u8[i * 16 + 13]
      this.meta[w * 4 + 2] = Math.sqrt(x * x + y * y + z * z)
      this.meta[w * 4 + 3] = f.timestamp
      this.label[w] = truth ? truth[i] : 0
      if (++w === CAPACITY) w = 0
    }
    this.write = w
    if (n > 0) {
      if (w > start) this.markDirty(start, w - start)
      else {
        this.markDirty(start, CAPACITY - start)
        this.markDirty(0, w)
      }
      this.sweepAz = (f.u16[(n - 1) * 8 + 7] * Math.PI) / 18000
    }
    this.pointsHeld = Math.min(CAPACITY, this.pointsHeld + n)
    this.geometry.setDrawRange(0, this.pointsHeld)
    this.ego = { x: f.x, y: f.y, yaw: f.yaw, z: f.z }
    this.now = f.timestamp
    this.stampWall = performance.now()
  }

  private markDirty(start: number, count: number): void {
    if (count <= 0) return
    this.aPos.addUpdateRange(start * 3, count * 3)
    this.aMeta.addUpdateRange(start * 4, count * 4)
    this.aLabel.addUpdateRange(start, count)
    this.aPos.needsUpdate = this.aMeta.needsUpdate = this.aLabel.needsUpdate = true
  }

  clear(): void {
    this.write = 0
    this.pointsHeld = 0
    this.geometry.setDrawRange(0, 0)
    this.tracks = []
  }

  setTracks(tracks: Track[], time: number): void {
    this.tracks = tracks
    this.tracksTime = time
  }

  setSelected(id: number | null): void {
    this.selected = id
  }

  setRunning(running: boolean): void {
    this.running = running
  }

  setGround(z: number): void {
    this.ground = z
    this.material.uniforms.uGround.value = z
  }

  // ── Appearance ──────────────────────────────────────────────────────────

  setPalette(id: PaletteId): void {
    this.palette = id
    const p = PALETTES[id]
    this.renderer.setClearColor(p.water)
    ;(this.material.uniforms.uWater.value as THREE.Color).set(p.water)
    const set = (o: THREE.Line | THREE.LineSegments, color: string, opacity: number) => {
      const m = o.material as THREE.LineBasicMaterial
      m.color.set(color)
      m.opacity = opacity
    }
    set(this.egoMark, p.ink, 1)
    set(this.sweep, p.ink, 0.35)
    set(this.outline, p.outline, id === 'day' ? 0.22 : 0.28)
    set(this.boxes, p.computed, 1)
    ;(this.selection.material as THREE.MeshBasicMaterial).color.set(p.computed)
    this.updateRamp()
    this.rebuildChart()
  }

  setColorMode(mode: ColorMode): void {
    this.mode = mode
    this.material.uniforms.uMode.value = MODE_INDEX[mode]
    this.updateRamp()
  }

  private updateRamp(): void {
    this.rampTex.image.data.set(buildRamp(PALETTES[this.palette], this.mode))
    const f = this.mode === 'truth' || this.mode === 'ring' ? THREE.NearestFilter : THREE.LinearFilter
    this.rampTex.magFilter = this.rampTex.minFilter = f
    this.rampTex.needsUpdate = true
  }

  setPointSize(px: number): void {
    this.material.uniforms.uSize.value = px
  }

  setPersistence(seconds: number): void {
    this.material.uniforms.uPersist.value = seconds
  }

  setMaxRange(m: number): void {
    if (m === this.maxRange) return
    this.maxRange = m
    this.material.uniforms.uMaxRange.value = m
    this.rebuildChart()
  }

  setLayers(l: Layers): void {
    this.layers = l
    this.chart.visible = l.contours
    this.sweep.visible = l.sweep
    this.outline.visible = l.outline
    this.boxes.visible = l.tracks
  }

  /** Building boxes from the simulator: cx, cy, cz, hx, hy, hz, yaw each. */
  setOutline(b: Float32Array | null): void {
    const pts: number[] = []
    for (let i = 0; b && i < b.length; i += 7) {
      const [cx, cy, cz, hx, hy, hz, yaw] = b.subarray(i, i + 7)
      pushBoxEdges(pts, cx, cy, cz, hx * 2, hy * 2, hz * 2, yaw)
    }
    this.outline.geometry.dispose()
    this.outline.geometry = new THREE.BufferGeometry().setAttribute(
      'position',
      new THREE.BufferAttribute(new Float32Array(pts), 3),
    )
  }

  /** Depth tints and range contours, rebuilt when the palette or the range changes. */
  private rebuildChart(): void {
    const p = PALETTES[this.palette]
    for (const g of [this.tintGroup, this.contourGroup]) {
      for (const c of [...g.children]) {
        const o = c as THREE.Mesh
        o.geometry.dispose()
        ;(o.material as THREE.Material).dispose()
        g.remove(c)
      }
    }
    const bands = Math.ceil(this.maxRange / CONTOUR_STEP)
    for (let i = 0; i < bands; i++) {
      const outer = Math.min(this.maxRange, (i + 1) * CONTOUR_STEP)
      const tint = new THREE.Mesh(
        new THREE.RingGeometry(i * CONTOUR_STEP, outer, 128),
        new THREE.MeshBasicMaterial({ color: p.tints[Math.min(i, p.tints.length - 1)], depthWrite: false, depthTest: false }),
      )
      tint.renderOrder = -10
      this.tintGroup.add(tint)
      const pts: THREE.Vector3[] = []
      for (let k = 0; k < 180; k++) {
        const a = (k / 180) * Math.PI * 2
        pts.push(new THREE.Vector3(Math.cos(a) * outer, Math.sin(a) * outer, 0.02))
      }
      const ring = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: p.contour, transparent: true, opacity: i === bands - 1 ? 0.9 : 0.55, depthTest: false }),
      )
      ring.renderOrder = -9
      this.contourGroup.add(ring)
    }
    // Bearing ticks on the outer contour, every 10°, longer every 30°.
    const ticks: THREE.Vector3[] = []
    for (let d = 0; d < 360; d += 10) {
      const a = (d * Math.PI) / 180
      const r0 = this.maxRange, r1 = this.maxRange + (d % 30 === 0 ? 3.2 : 1.4)
      ticks.push(new THREE.Vector3(Math.cos(a) * r0, Math.sin(a) * r0, 0.02), new THREE.Vector3(Math.cos(a) * r1, Math.sin(a) * r1, 0.02))
    }
    const tickLines = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(ticks),
      new THREE.LineBasicMaterial({ color: p.contour, transparent: true, opacity: 0.9, depthTest: false }),
    )
    tickLines.renderOrder = -9
    this.contourGroup.add(tickLines)
  }

  // ── Camera ──────────────────────────────────────────────────────────────

  setCamera(preset: CameraPreset): void {
    this.goal = { ...PRESET_GOALS[preset] }
  }

  private bindPointer(canvas: HTMLCanvasElement): void {
    let down: { x: number; y: number; moved: number } | null = null
    canvas.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, moved: 0 }
      canvas.setPointerCapture(e.pointerId)
    })
    canvas.addEventListener('pointermove', (e) => {
      if (!down) return
      const dx = e.clientX - down.x, dy = e.clientY - down.y
      down.x = e.clientX
      down.y = e.clientY
      down.moved += Math.abs(dx) + Math.abs(dy)
      this.orbit(-dx * 0.006, -dy * 0.005)
    })
    canvas.addEventListener('pointerup', (e) => {
      if (down && down.moved < 5) this.pick(e.offsetX, e.offsetY)
      down = null
    })
    canvas.addEventListener('pointercancel', () => (down = null))
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault()
      this.zoom(Math.exp(e.deltaY * 0.0012))
    }, { passive: false })
    canvas.addEventListener('keydown', (e) => {
      const k = e.key
      if (k === 'ArrowLeft') this.orbit(-0.12, 0)
      else if (k === 'ArrowRight') this.orbit(0.12, 0)
      else if (k === 'ArrowUp') this.orbit(0, -0.08)
      else if (k === 'ArrowDown') this.orbit(0, 0.08)
      else if (k === '+' || k === '=') this.zoom(0.85)
      else if (k === '-') this.zoom(1.18)
      else return
      e.preventDefault()
    })
  }

  private orbit(dTheta: number, dPhi: number): void {
    this.goal.theta += dTheta
    this.goal.phi = Math.min(1.5, Math.max(0.03, this.goal.phi + dPhi))
    // Direct manipulation: no easing lag while dragging.
    this.rig.theta = this.goal.theta
    this.rig.phi = this.goal.phi
  }

  private zoom(factor: number): void {
    this.goal.dist = Math.min(320, Math.max(8, this.goal.dist * factor))
  }

  private pick(x: number, y: number): void {
    let best: number | null = null
    let bestD = 34
    for (const t of this.tracks) {
      const s = this.project(t.x, t.y, t.z)
      if (!s) continue
      const d = Math.hypot(s.x - x, s.y - y)
      if (d < bestD) {
        bestD = d
        best = t.id
      }
    }
    this.onSelect(best)
  }

  private project(x: number, y: number, z: number): { x: number; y: number } | null {
    const v = this.v.set(x, y, z).project(this.camera)
    if (v.z > 1 || v.z < -1 || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05) return null
    return { x: (v.x * 0.5 + 0.5) * this.host.clientWidth, y: (-v.y * 0.5 + 0.5) * this.host.clientHeight }
  }

  private resize(): void {
    const w = this.host.clientWidth, h = this.host.clientHeight
    if (!w || !h) return
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  // ── Frame ───────────────────────────────────────────────────────────────

  private frame = (): void => {
    this.raf = requestAnimationFrame(this.frame)
    const wall = performance.now()
    const dt = Math.min(0.1, (wall - this.lastFrame) / 1000)
    this.lastFrame = wall
    const k = this.reducedMotion ? 1 : 1 - Math.exp(-dt * 7)

    // Sensor time keeps running between packets so fades stay smooth.
    const simNow = this.now + (this.running ? Math.min(0.1, (wall - this.stampWall) / 1000) : 0)
    this.material.uniforms.uNow.value = simNow

    const e = this.ego
    this.target.x += (e.x - this.target.x) * k
    this.target.y += (e.y - this.target.y) * k
    this.target.z = this.ground + 1
    let dyaw = e.yaw - this.rig.yaw
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw))
    this.rig.yaw += dyaw * (this.reducedMotion ? 1 : 1 - Math.exp(-dt * 3))
    this.rig.theta += (this.goal.theta - this.rig.theta) * k
    this.rig.phi += (this.goal.phi - this.rig.phi) * k
    this.rig.dist += (this.goal.dist - this.rig.dist) * k
    const a = (this.goal.headingUp ? this.rig.yaw + Math.PI : -Math.PI / 2) + this.rig.theta
    const sp = Math.sin(this.rig.phi)
    this.camera.position.set(
      this.target.x + this.rig.dist * sp * Math.cos(a),
      this.target.y + this.rig.dist * sp * Math.sin(a),
      this.target.z + this.rig.dist * Math.cos(this.rig.phi),
    )
    this.camera.lookAt(this.target)

    this.chart.position.set(e.x, e.y, this.ground)
    this.egoMark.position.set(e.x, e.y, this.ground)
    this.egoMark.rotation.z = e.yaw
    this.sweep.position.set(e.x, e.y, e.z)
    this.sweep.rotation.z = e.yaw + this.sweepAz
    this.sweep.scale.setScalar(this.maxRange)

    this.used = 0
    if (this.layers.contours) this.drawSoundings(a)
    this.drawTracks(simNow)
    for (let i = this.used; i < this.pool.length; i++) this.pool[i].hidden = true

    this.renderer.render(this.scene, this.camera)
  }

  private labelAt(x: number, y: number, z: number, text: string, cls: string): void {
    const s = this.project(x, y, z)
    if (!s) return
    let el = this.pool[this.used]
    if (!el) {
      el = document.createElement('span')
      this.labels.appendChild(el)
      this.pool.push(el)
    }
    this.used++
    if (el.textContent !== text) el.textContent = text
    if (el.className !== cls) el.className = cls
    el.hidden = false
    el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px)`
  }

  /** Contour distances, set like chart soundings along the bearing to the viewer's right. */
  private drawSoundings(cameraAz: number): void {
    const b = cameraAz + Math.PI / 2 + 0.35
    const bands = Math.ceil(this.maxRange / CONTOUR_STEP)
    for (let i = 0; i < bands; i++) {
      const r = Math.min(this.maxRange, (i + 1) * CONTOUR_STEP)
      this.labelAt(
        this.ego.x + Math.cos(b) * r, this.ego.y + Math.sin(b) * r, this.ground,
        i === bands - 1 ? `${r} m` : `${r}`, 'sounding',
      )
    }
  }

  private drawTracks(simNow: number): void {
    const lead = Math.max(0, Math.min(0.25, simNow - this.tracksTime))
    const pts: number[] = []
    let sel: Track | null = null
    if (this.layers.tracks) {
      for (const t of this.tracks.slice(0, MAX_TRACKS)) {
        const x = t.x + t.vx * lead, y = t.y + t.vy * lead
        pushBoxEdges(pts, x, y, t.z, t.length, t.width, t.height, t.yaw)
        const speed = Math.hypot(t.vx, t.vy)
        if (speed > 0.8) {
          // One second of travel, drawn like a course vector.
          pts.push(x, y, t.z, x + t.vx, y + t.vy, t.z)
        } else {
          pts.push(x, y, t.z, x, y, t.z)
        }
        const selected = t.id === this.selected
        if (selected) sel = { ...t, x, y }
        this.labelAt(x, y, t.z + t.height / 2 + 0.4, trackName(t.id), selected ? 'track is-selected' : 'track')
      }
    }
    this.boxPositions.set(pts)
    const attr = this.boxes.geometry.getAttribute('position') as THREE.BufferAttribute
    attr.needsUpdate = true
    this.boxes.geometry.setDrawRange(0, pts.length / 3)
    this.selection.visible = sel !== null
    if (sel) {
      this.selection.position.set(sel.x, sel.y, sel.z)
      this.selection.scale.set(sel.length + 0.3, sel.width + 0.3, sel.height + 0.3)
      this.selection.rotation.z = sel.yaw
    }
  }
}

export function trackName(id: number): string {
  return `T-${String(id).padStart(2, '0')}`
}

function pushBoxEdges(
  out: number[], cx: number, cy: number, cz: number,
  l: number, w: number, h: number, yaw: number,
): void {
  const c = Math.cos(yaw), s = Math.sin(yaw)
  const hx = l / 2, hy = w / 2, hz = h / 2
  const corner = (i: number): [number, number, number] => {
    const u = i & 1 ? hx : -hx, v = i & 2 ? hy : -hy
    return [cx + u * c - v * s, cy + u * s + v * c, cz + (i & 4 ? hz : -hz)]
  }
  const edges = [0, 1, 1, 3, 3, 2, 2, 0, 4, 5, 5, 7, 7, 6, 6, 4, 0, 4, 1, 5, 2, 6, 3, 7]
  for (const i of edges) out.push(...corner(i))
}
