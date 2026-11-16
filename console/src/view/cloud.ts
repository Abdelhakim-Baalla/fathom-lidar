import * as THREE from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import type { Track } from '../perception/track'
import type { Frame } from '../protocol/frame'
import { buildRamp, HEIGHT_MAX, PALETTE, type ColorMode } from './palettes'

THREE.ColorManagement.enabled = false

const CAPACITY = 1_600_000
const MAX_TRACKS = 96
const MODE_INDEX: Record<ColorMode, number> = { range: 0, intensity: 1, height: 2, ring: 3, truth: 4 }

const VERT = /* glsl */ `
attribute vec4 aMeta;   // intensity 0..255, ring, range in metres, capture time in seconds
attribute float aLabel;
uniform sampler2D uRamp;
uniform vec3 uSensor;
uniform float uNow, uPersist, uSize, uPx, uMaxRange, uGround, uHeightMax, uYaw, uSweepAz;
uniform int uMode;
varying vec3 vColor;
void main() {
  float age = uNow - aMeta.w;
  if (age > uPersist || age < -0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  float t;
  if (uMode == 0) t = aMeta.z / uMaxRange;
  else if (uMode == 1) t = aMeta.x <= 100.0 ? aMeta.x / 100.0 * 0.8 : 0.8 + (aMeta.x - 100.0) / 155.0 * 0.2;
  else if (uMode == 2) t = (position.z - uGround) / uHeightMax;
  else if (uMode == 3) t = mod(aMeta.y, 2.0) < 0.5 ? 0.25 : 0.75;
  else t = (aLabel * 16.0 + 8.0) / 255.0;
  vec3 c = texture2D(uRamp, vec2(clamp(t, 0.002, 0.998), 0.5)).rgb;

  // Intensity is the return's power: it drives size and brightness the way a
  // real viewer does. Ground truth keeps the class colours untouched.
  float i = aMeta.x / 255.0;
  float physical = uMode == 4 ? 0.0 : 1.0;
  float retro = smoothstep(0.68, 0.9, i) * physical;

  // The live beam column flashes: returns near the firing azimuth catch the light.
  vec2 d = position.xy - uSensor.xy;
  float wa = atan(d.y, d.x);
  float da = abs(atan(sin(wa - (uYaw + uSweepAz)), cos(wa - (uYaw + uSweepAz))));
  float flash = smoothstep(0.11, 0.0, da) * step(0.5, length(d)) * physical;
  float fresh = 1.0 - smoothstep(0.0, 0.11, age);

  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = max(-mv.z, 1.0);
  float near = clamp(27.0 / depth, 0.62, 1.35);
  gl_PointSize = min(uSize * uPx * near * (0.9 + 0.4 * i + 0.6 * flash + 0.3 * fresh + 0.7 * retro), 9.0 * uPx);

  // Old returns and distant returns sink into the dark instead of popping out.
  // Distance is measured from the sensor, not the camera: a plan view should not
  // dim the whole city just because the camera is high above it.
  float fade = 1.0 - smoothstep(0.55, 1.0, age / uPersist) * 0.85;
  fade *= 1.0 - smoothstep(0.4, 1.0, aMeta.z / uMaxRange) * 0.8;

  // Keep the hierarchy of a survey: structure reads first, the ground is the
  // chart it stands on, foliage and weather sit back. Truth mode is untouched.
  float rank = 1.0;
  if (uMode != 4) {
    if (aLabel < 0.5) rank = 0.82;
    else if (aLabel > 0.5 && aLabel < 1.5) rank = 1.05;
    else if (aLabel > 1.5 && aLabel < 2.5) rank = 0.9;
    else if (aLabel > 7.5) rank = 0.4;
  }

  // The sweep front carries a little warmth, like a searchlight crossing the
  // scene. Retroreflectors burn warm and the freshest returns keep a trace of it.
  float heat = 0.42 * retro + 0.4 * flash + 0.16 * fresh;
  vColor = (c * (0.42 + 0.9 * i) * (1.0 + 0.22 * fresh) + vec3(1.0, 0.93, 0.78) * heat) * fade * rank;
}`

const FRAG = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 c = gl_PointCoord - 0.5;
  float d2 = dot(c, c);
  if (d2 > 0.25) discard;
  float a = smoothstep(0.25, 0.05, d2);
  if (a < 0.16) discard;
  gl_FragColor = vec4(vColor, a);
}`

const VIGNETTE = {
  uniforms: { tDiffuse: { value: null } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D(tDiffuse, vUv);
      float d = distance(vUv, vec2(0.5));
      c.rgb *= mix(0.5, 1.0, smoothstep(0.86, 0.24, d));
      // A trace of night haze above the skyline keeps the unlit room from
      // reading as a dead rectangle behind the cloud.
      float sky = smoothstep(0.35, 1.0, vUv.y) * (1.0 - smoothstep(0.08, 0.72, abs(vUv.x - 0.5)));
      c.rgb += vec3(0.038, 0.048, 0.056) * sky;
      // A trace of sensor grain keeps the blacks from looking like flat UI.
      float g = fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
      c.rgb += g * 0.012 * (0.25 + 0.75 * (1.0 - smoothstep(0.2, 0.95, d)));
      gl_FragColor = c;
    }`,
}

export type CameraPreset = 'chase' | 'plan' | 'side'

const PRESET_GOALS: Record<CameraPreset, { theta: number; phi: number; dist: number; headingUp: boolean; ahead: number }> = {
  chase: { theta: 0.48, phi: 1.04, dist: 41, headingUp: true, ahead: 12 },
  plan: { theta: 0, phi: 0.06, dist: 138, headingUp: false, ahead: 0 },
  side: { theta: 1.32, phi: 1.14, dist: 54, headingUp: true, ahead: 6 },
}

export interface Layers {
  rings: boolean
  tracks: boolean
  sweep: boolean
  outline: boolean
}

/** WebGL view of the point cloud with range rings and exhibit markers. Owns its canvas and a DOM label layer. */
export class CloudView {
  onSelect: (id: number | null) => void = () => {}
  /** exhibit number for a track, assigned by the engine's register */
  exhibitOf: (trackId: number) => number | undefined = () => undefined
  pointsHeld = 0

  private inputEvents = new AbortController()
  private renderer: THREE.WebGLRenderer
  private scene = new THREE.Scene()
  private camera = new THREE.PerspectiveCamera(42, 1, 0.1, 900)
  private labels: HTMLElement
  private host: HTMLElement
  private composer: EffectComposer
  private bloom: UnrealBloomPass
  private vignette: ShaderPass

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

  private mode: ColorMode = 'range'
  private layers: Layers = { rings: true, tracks: true, sweep: true, outline: false }
  private maxRange = 120
  private fovUp = 15
  private fovDown = -25

  private chart = new THREE.Group() // follows the sensor, north up
  private contourGroup = new THREE.Group()
  private rig = new THREE.Group()
  private drum = new THREE.Group()
  private beam = new THREE.Group()
  private beamFan: THREE.LineSegments
  private beamGround: THREE.Line
  private aperture: THREE.Mesh
  private platform: THREE.Group
  private outline: THREE.LineSegments
  private brackets: THREE.LineSegments
  private links: THREE.LineSegments
  private bracketPositions = new Float32Array(MAX_TRACKS * 48 * 3)
  private linkPositions = new Float32Array(MAX_TRACKS * 14 * 3)
  private selection: THREE.Mesh
  private lights: THREE.Group
  private halo: THREE.Group
  private beacon: THREE.Sprite

  private ego = { x: 3, y: 10, yaw: Math.PI / 2, z: 1.9 }
  private ground = 0
  private sweepAz = 0
  private now = 0
  private stampWall = 0
  private running = true

  private tracks: Track[] = []
  private tracksTime = 0
  private selected: number | null = null

  private orbitState = { theta: 0, phi: 1.12, dist: 52, yaw: Math.PI / 2 }
  /** camera distances are authored for a 120 m sensor and scale with the range in use */
  private scale = 1
  private goal = { ...PRESET_GOALS.chase }
  private target = new THREE.Vector3(3, 10, 0)
  private raf = 0
  private lastFrame = performance.now()
  private observer: ResizeObserver
  private pool: HTMLElement[] = []
  private markers = new Map<number, HTMLElement>()
  private used = 0
  private v = new THREE.Vector3()
  private reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches

  constructor(canvas: HTMLCanvasElement, labels: HTMLElement) {
    this.host = canvas.parentElement!
    this.labels = labels
    // Request once, before Three.js initialization: a denied context is a local
    // view failure, not an exception that should take down the instruments.
    const context = canvas.getContext('webgl2', { antialias: true, alpha: false })
    if (!context) throw new Error('WebGL 2 is unavailable')
    this.renderer = new THREE.WebGLRenderer({ canvas, context })
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.14
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
      transparent: true,
      depthWrite: true,
      blending: THREE.NormalBlending,
      uniforms: {
        uRamp: { value: this.rampTex },
        uSensor: { value: new THREE.Vector3() },
        uNow: { value: 0 },
        uPersist: { value: 0.62 },
        uSize: { value: 2.4 },
        uPx: { value: this.renderer.getPixelRatio() },
        uMaxRange: { value: 120 },
        uGround: { value: 0 },
        uHeightMax: { value: HEIGHT_MAX },
        uYaw: { value: 0 },
        uSweepAz: { value: 0 },
        uMode: { value: 0 },
      },
    })
    const cloud = new THREE.Points(this.geometry, this.material)
    cloud.frustumCulled = false
    this.scene.add(cloud)

    const line = (opacity: number, color = PALETTE.ink) =>
      new THREE.LineBasicMaterial({ transparent: true, opacity, color, blending: THREE.AdditiveBlending, depthWrite: false })
    const lineNoBlend = (opacity: number, color = PALETTE.ink) =>
      new THREE.LineBasicMaterial({ transparent: true, opacity, color, depthWrite: false })

    this.outline = new THREE.LineSegments(new THREE.BufferGeometry(), lineNoBlend(0.24, PALETTE.outline))
    this.outline.frustumCulled = false
    const boxGeo = new THREE.BufferGeometry()
    boxGeo.setAttribute('position', new THREE.BufferAttribute(this.bracketPositions, 3).setUsage(THREE.DynamicDrawUsage))
    boxGeo.setDrawRange(0, 0)
    this.brackets = new THREE.LineSegments(boxGeo, line(0.68, PALETTE.exhibit))
    this.brackets.frustumCulled = false
    const linkGeo = new THREE.BufferGeometry()
    linkGeo.setAttribute('position', new THREE.BufferAttribute(this.linkPositions, 3).setUsage(THREE.DynamicDrawUsage))
    linkGeo.setDrawRange(0, 0)
    this.links = new THREE.LineSegments(linkGeo, line(0.3, PALETTE.exhibit))
    this.links.frustumCulled = false

    this.selection = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: PALETTE.ink, transparent: true, opacity: 0.08, depthWrite: false }),
    )
    this.selection.visible = false

    // ── Sensor platform ────────────────────────────────────────────────────
    // A roof pod with a spinning drum. Modelling it (rather than a flat marker)
    // gives the cloud a physical origin the eye can measure the returns against.
    const metal = new THREE.MeshStandardMaterial({ color: 0x3a444a, metalness: 0.72, roughness: 0.34 })
    const shell = new THREE.MeshStandardMaterial({ color: 0x191f23, metalness: 0.42, roughness: 0.5 })
    const glow = new THREE.MeshBasicMaterial({ color: PALETTE.exhibit })
    const podZ = 1.98
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.47, 0.1, 28), metal)
    base.position.z = 1.62
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.11, 0.26, 12), shell)
    mast.position.z = 1.79
    const drumBody = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.34, 32), shell)
    drumBody.position.z = podZ
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.315, 0.07, 32), metal)
    cap.position.z = podZ + 0.2
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.322, 0.008, 6, 40), glow)
    collar.position.z = podZ + 0.02
    collar.rotation.x = Math.PI / 2
    const slit = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.06, 0.15), glow)
    slit.position.set(0, 0.3, podZ)
    this.aperture = new THREE.Mesh(new THREE.SphereGeometry(0.038, 8, 6), glow)
    this.aperture.position.set(0, 0.34, podZ + 0.02)
    this.drum.add(slit, this.aperture)
    // Cap bolts: a machined head rather than a smooth toy cylinder.
    const bolts = new THREE.Group()
    bolts.position.z = podZ + 0.24
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2
      const bolt = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.025, 6), metal)
      bolt.position.set(Math.cos(a) * 0.225, Math.sin(a) * 0.225, 0)
      bolts.add(bolt)
    }
    this.rig.add(base, mast, drumBody, cap, collar, this.drum, bolts)
    this.rig.position.z = 0

    this.platform = buildVehicle()
    this.rig.add(this.platform)

    this.lights = new THREE.Group()
    const hemi = new THREE.HemisphereLight(0xa8bcc6, 0x05070a, 1.4)
    const key = new THREE.DirectionalLight(0xe6eef2, 1.9)
    key.position.set(-24, -18, 46)
    const rim = new THREE.DirectionalLight(0xf48142, 0.55)
    rim.position.set(30, 20, 12)
    this.lights.add(hemi, key, rim)

    // Beam fan: the vertical field of the spinning head, drawn as thin rays.
    this.beamFan = new THREE.LineSegments(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.15, blending: THREE.AdditiveBlending, depthWrite: false }),
    )
    this.beamFan.frustumCulled = false
    this.beamGround = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(1, 0, 0)]),
      new THREE.LineBasicMaterial({ color: 0xffffff, vertexColors: true, transparent: true, opacity: 0.36, blending: THREE.AdditiveBlending, depthWrite: false }),
    )
    this.beamGround.frustumCulled = false
    this.beam.add(this.beamFan, this.beamGround)
    this.beam.position.z = 1.98

    // A survey ring at the sensor's ground position, and a soft beacon on the
    // pod: two cues that give the origin a fixed place in the picture.
    this.halo = new THREE.Group()
    const haloPts: THREE.Vector3[] = []
    for (let k = 0; k < 72; k++) {
      const a = (k / 72) * Math.PI * 2
      haloPts.push(new THREE.Vector3(Math.cos(a) * 3.2, Math.sin(a) * 3.2, 0))
    }
    const haloRing = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(haloPts),
      new THREE.LineBasicMaterial({ color: PALETTE.ink, transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false }),
    )
    const haloCross: number[] = []
    for (const a of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const c = Math.cos(a), s = Math.sin(a)
      haloCross.push(c * 2.7, s * 2.7, 0, c * 4.2, s * 4.2, 0)
    }
    const haloMarks = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(haloCross), 3)),
      new THREE.LineBasicMaterial({ color: PALETTE.ink, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }),
    )
    haloRing.renderOrder = haloMarks.renderOrder = 3
    this.halo.add(haloRing, haloMarks)

    const glowCanvas = document.createElement('canvas')
    glowCanvas.width = glowCanvas.height = 64
    const g2 = glowCanvas.getContext('2d')!
    const grad = g2.createRadialGradient(32, 32, 0, 32, 32, 32)
    grad.addColorStop(0, 'rgba(255, 232, 168, 0.9)')
    grad.addColorStop(0.3, 'rgba(244, 129, 66, 0.35)')
    grad.addColorStop(1, 'rgba(244, 129, 66, 0)')
    g2.fillStyle = grad
    g2.fillRect(0, 0, 64, 64)
    const glowTex = new THREE.CanvasTexture(glowCanvas)
    this.beacon = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex, color: 0xffffff, transparent: true, opacity: 0.55,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }))
    this.beacon.position.z = 1.99
    this.beacon.scale.setScalar(4.5)
    this.rig.add(this.beacon)

    this.chart.add(this.contourGroup)
    this.scene.add(this.chart, this.halo, this.rig, this.beam, this.outline, this.brackets, this.links, this.selection, this.lights)
    this.rebuildFan()

    this.composer = new EffectComposer(this.renderer)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.34, 0.5, 0.9)
    this.composer.addPass(this.bloom)
    this.vignette = new ShaderPass(VIGNETTE)
    this.composer.addPass(this.vignette)
    this.composer.addPass(new OutputPass())

    this.applyPalette()
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
    this.inputEvents.abort()
    for (const pass of this.composer.passes) pass.dispose()
    this.composer.dispose()
    this.renderer.dispose()
    const materials = new Set<THREE.Material>()
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh
      mesh.geometry?.dispose()
      if (mesh.material) {
        for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material)
      }
    })
    for (const material of materials) material.dispose()
    this.rampTex.dispose()
    this.beacon.material.map?.dispose()
    this.labels.replaceChildren()
    this.markers.clear()
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
    for (const el of this.markers.values()) el.remove()
    this.markers.clear()
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

  private applyPalette(): void {
    const p = PALETTE
    this.renderer.setClearColor(p.ground)
    const set = (o: THREE.Line | THREE.LineSegments, color: string, opacity: number) => {
      const m = o.material as THREE.LineBasicMaterial
      m.color.set(color)
      m.opacity = opacity
    }
    set(this.outline, p.outline, 0.24)
    set(this.brackets, p.exhibit, 0.95)
    set(this.links, p.exhibit, 0.42)
    ;(this.selection.material as THREE.MeshBasicMaterial).color.set(p.ink)
    this.updateRamp()
  }

  setColorMode(mode: ColorMode): void {
    this.mode = mode
    this.material.uniforms.uMode.value = MODE_INDEX[mode]
    this.updateRamp()
  }

  private updateRamp(): void {
    this.rampTex.image.data!.set(buildRamp(PALETTE, this.mode))
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
    this.rebuildFan()
  }

  /** Vertical field of view, so the beam fan matches the modelled head. */
  setBeam(fovUp: number, fovDown: number): void {
    if (fovUp === this.fovUp && fovDown === this.fovDown) return
    this.fovUp = fovUp
    this.fovDown = fovDown
    this.rebuildFan()
  }

  setLayers(l: Layers): void {
    this.layers = l
    this.chart.visible = l.rings
    this.beam.visible = l.sweep
    this.outline.visible = l.outline
    this.brackets.visible = l.tracks
    this.links.visible = l.tracks
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

  /** Ring interval: about six rings whatever the range. */
  private get step(): number {
    const raw = this.maxRange / 6
    return [1, 2, 5, 10, 20, 25, 50].find((s) => s >= raw) ?? 50
  }

  private rebuildChart(): void {
    const p = PALETTE
    const CONTOUR_STEP = this.step
    for (const c of [...this.contourGroup.children]) {
      const o = c as THREE.Mesh
      o.geometry.dispose()
      ;(o.material as THREE.Material).dispose()
      this.contourGroup.remove(c)
    }
    const bands = Math.ceil(this.maxRange / CONTOUR_STEP)
    for (let i = 0; i < bands; i++) {
      const outer = Math.min(this.maxRange, (i + 1) * CONTOUR_STEP)
      const pts: THREE.Vector3[] = []
      for (let k = 0; k < 180; k++) {
        const a = (k / 180) * Math.PI * 2
        pts.push(new THREE.Vector3(Math.cos(a) * outer, Math.sin(a) * outer, 0.02))
      }
      const ring = new THREE.LineLoop(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color: p.scale, transparent: true, opacity: i === bands - 1 ? 0.5 : 0.24, depthTest: false }),
      )
      ring.renderOrder = -9
      this.contourGroup.add(ring)
    }
    // Bearing ticks on the outer contour, every 10°, longer every 30°.
    const ticks: THREE.Vector3[] = []
    for (let d = 0; d < 360; d += 10) {
      const a = (d * Math.PI) / 180
      const r0 = this.maxRange, r1 = this.maxRange * (d % 30 === 0 ? 1.027 : 1.012)
      ticks.push(new THREE.Vector3(Math.cos(a) * r0, Math.sin(a) * r0, 0.02), new THREE.Vector3(Math.cos(a) * r1, Math.sin(a) * r1, 0.02))
    }
    const tickLines = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(ticks),
      new THREE.LineBasicMaterial({ color: p.scale, transparent: true, opacity: 0.75, depthTest: false }),
    )
    tickLines.renderOrder = -9
    this.contourGroup.add(tickLines)
  }

  private rebuildFan(): void {
    const R = Math.min(this.maxRange * 0.28, 32)
    const pos: number[] = []
    const col: number[] = []
    const tint = new THREE.Color(PALETTE.exhibit)
    const N = 14
    for (let k = 0; k < N; k++) {
      const el = ((this.fovDown + ((this.fovUp - this.fovDown) * k) / (N - 1)) * Math.PI) / 180
      pos.push(0, 0, 0, Math.cos(el) * R, 0, Math.sin(el) * R)
      // Additive blending fades each ray out by carrying its colour to black.
      col.push(tint.r, tint.g, tint.b, 0, 0, 0)
    }
    this.beamFan.geometry.dispose()
    const fan = new THREE.BufferGeometry()
    fan.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    fan.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
    this.beamFan.geometry = fan

    const mount = Math.max(0, this.ego.z - this.ground)
    const len = Math.min(this.maxRange * 0.26, 30)
    this.beamGround.geometry.dispose()
    const ground = new THREE.BufferGeometry()
    ground.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, len, 0, 0], 3))
    ground.setAttribute('color', new THREE.Float32BufferAttribute([tint.r, tint.g, tint.b, 0, 0, 0], 3))
    this.beamGround.geometry = ground
    this.beamGround.position.z = -mount + 0.05
  }

  // ── Camera ──────────────────────────────────────────────────────────────

  setCamera(preset: CameraPreset): void {
    this.goal = { ...PRESET_GOALS[preset] }
  }

  private bindPointer(canvas: HTMLCanvasElement): void {
    const signal = this.inputEvents.signal
    let down: { x: number; y: number; moved: number } | null = null
    canvas.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY, moved: 0 }
      canvas.setPointerCapture(e.pointerId)
    }, { signal })
    canvas.addEventListener('pointermove', (e) => {
      if (!down) return
      const dx = e.clientX - down.x, dy = e.clientY - down.y
      down.x = e.clientX
      down.y = e.clientY
      down.moved += Math.abs(dx) + Math.abs(dy)
      this.orbit(-dx * 0.006, -dy * 0.005)
    }, { signal })
    canvas.addEventListener('pointerup', (e) => {
      if (down && down.moved < 5) this.pick(e.offsetX, e.offsetY)
      down = null
    }, { signal })
    canvas.addEventListener('pointercancel', () => (down = null), { signal })
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault()
      this.zoom(Math.exp(e.deltaY * 0.0012))
    }, { passive: false, signal })
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
    }, { signal })
  }

  private orbit(dTheta: number, dPhi: number): void {
    this.goal.theta += dTheta
    this.goal.phi = Math.min(1.5, Math.max(0.03, this.goal.phi + dPhi))
    // Direct manipulation: no easing lag while dragging.
    this.orbitState.theta = this.goal.theta
    this.orbitState.phi = this.goal.phi
  }

  private zoom(factor: number): void {
    this.goal.dist = Math.min(320, Math.max(6, this.goal.dist * factor))
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
    this.composer.setPixelRatio(this.renderer.getPixelRatio())
    this.composer.setSize(w, h)
    this.bloom.setSize(w, h)
  }

  // ── Frame ───────────────────────────────────────────────────────────────

  private frame = (): void => {
    this.raf = requestAnimationFrame(this.frame)
    if (this.renderer.getContext().isContextLost()) return
    const wall = performance.now()
    const dt = Math.min(0.1, (wall - this.lastFrame) / 1000)
    this.lastFrame = wall
    const k = this.reducedMotion ? 1 : 1 - Math.exp(-dt * 7)

    // Sensor time keeps running between packets so fades stay smooth.
    const simNow = this.now + (this.running ? Math.min(0.1, (wall - this.stampWall) / 1000) : 0)
    this.material.uniforms.uNow.value = simNow
    this.material.uniforms.uSensor.value.set(this.ego.x, this.ego.y, this.ego.z)
    this.material.uniforms.uYaw.value = this.ego.yaw
    this.material.uniforms.uSweepAz.value = this.sweepAz

    const e = this.ego
    const scale = this.scale
    const fx = Math.cos(e.yaw), fy = Math.sin(e.yaw)
    const ahead = this.goal.ahead * Math.max(0.25, scale)
    this.target.x += (e.x + fx * ahead - this.target.x) * k
    this.target.y += (e.y + fy * ahead - this.target.y) * k
    this.target.z = this.ground + 1
    let dyaw = e.yaw - this.orbitState.yaw
    dyaw = Math.atan2(Math.sin(dyaw), Math.cos(dyaw))
    this.orbitState.yaw += dyaw * (this.reducedMotion ? 1 : 1 - Math.exp(-dt * 3))
    this.orbitState.theta += (this.goal.theta - this.orbitState.theta) * k
    this.orbitState.phi += (this.goal.phi - this.orbitState.phi) * k
    this.orbitState.dist += (this.goal.dist - this.orbitState.dist) * k
    this.scale += (Math.max(0.12, this.maxRange / 120) - this.scale) * k
    const dist = this.orbitState.dist * scale
    const a = (this.goal.headingUp ? this.orbitState.yaw + Math.PI : -Math.PI / 2) + this.orbitState.theta
    const sp = Math.sin(this.orbitState.phi)
    this.camera.position.set(
      this.target.x + dist * sp * Math.cos(a),
      this.target.y + dist * sp * Math.sin(a),
      this.target.z + dist * Math.cos(this.orbitState.phi),
    )
    this.camera.lookAt(this.target)

    // Chart and survey grid follow the sensor; the grid snaps to its own 10 m
    // module so it does not crawl through the returns while the vehicle moves.
    this.chart.position.set(Math.round(e.x / 10) * 10, Math.round(e.y / 10) * 10, this.ground + 0.01)
    const mount = Math.max(0.02, e.z - this.ground)
    const platformOn = mount > 0.6
    this.platform.visible = platformOn
    // The pod is modelled at 1.98 m in its own frame; lift or drop the rig so
    // the drum's optical centre sits at the frame's mount height.
    this.rig.position.set(e.x, e.y, this.ground + mount - 1.98)
    this.halo.position.set(e.x, e.y, this.ground + 0.04)
    this.rig.rotation.z = e.yaw
    this.drum.rotation.z = this.sweepAz
    this.beam.position.set(e.x, e.y, this.ground + mount)
    this.beam.rotation.z = e.yaw + this.sweepAz
    this.beamGround.position.z = -mount + 0.05

    this.used = 0
    if (this.layers.rings) this.drawRangeMarks(a)
    this.drawTracks(simNow)
    for (let i = this.used; i < this.pool.length; i++) this.pool[i].hidden = true

    this.composer.render()
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

  /** Ring distances along a bearing ahead of the viewer, a little to the right. */
  private drawRangeMarks(cameraAz: number): void {
    const b = cameraAz + Math.PI + 0.42
    const CONTOUR_STEP = this.step
    const bands = Math.ceil(this.maxRange / CONTOUR_STEP)
    for (let i = 0; i < bands; i++) {
      const r = Math.min(this.maxRange, (i + 1) * CONTOUR_STEP)
      this.labelAt(
        this.ego.x + Math.cos(b) * r, this.ego.y + Math.sin(b) * r, this.ground,
        `${r} m`, 'rangemark',
      )
    }
    // Cardinal points on the outer ring: the survey is north-up, so the scan
    // answers a bearing without a separate compass.
    const r = this.maxRange * 0.94
    for (const [deg, text] of [[90, 'N'], [0, 'E'], [-90, 'S'], [180, 'W']] as const) {
      const a = (deg * Math.PI) / 180
      this.labelAt(
        this.ego.x + Math.cos(a) * r, this.ego.y + Math.sin(a) * r, this.ground,
        text, 'bearing',
      )
    }
  }

  private drawTracks(simNow: number): void {
    const lead = Math.max(0, Math.min(0.25, simNow - this.tracksTime))
    const pts: number[] = []
    const links: number[] = []
    const live = new Set<number>()
    let sel: Track | null = null
    if (this.layers.tracks) {
      for (const t of this.tracks.slice(0, MAX_TRACKS)) {
        const x = t.x + t.vx * lead, y = t.y + t.vy * lead
        const speed = Math.hypot(t.vx, t.vy)
        const selected = t.id === this.selected
        // A tracking volume is a claim on a moving object. Static kerbside cars
        // keep their tag and tether, but no crate drawn round them.
        if (selected || (speed > 0.8 && Math.hypot(x - this.ego.x, y - this.ego.y) < 40)) {
          pushBrackets(pts, x, y, t.z, t.length, t.width, t.height, t.yaw)
        }
        // A cross on the road below and a tether to the box's floor.
        const bottom = t.z - t.height / 2
        cross(links, x, y, this.ground + 0.04, 0.9)
        links.push(x, y, bottom, x, y, this.ground + 0.04)
        if (speed > 0.8) {
          // One and a half seconds of travel, drawn as a course vector with a head.
          const ex = x + t.vx * 1.5, ey = y + t.vy * 1.5
          links.push(x, y, t.z, ex, ey, t.z)
          const h = Math.min(1.2, speed * 0.35), ang = Math.atan2(t.vy, t.vx)
          links.push(ex, ey, t.z, ex - Math.cos(ang - 0.45) * h, ey - Math.sin(ang - 0.45) * h, t.z)
          links.push(ex, ey, t.z, ex - Math.cos(ang + 0.45) * h, ey - Math.sin(ang + 0.45) * h, t.z)
        }
        // A faint volume gives the points inside weight without hiding them.
        if (selected) sel = { ...t, x, y }
        live.add(t.id)
        this.placeMarker(t.id, x, y, t.z + t.height / 2 + 0.3, selected)
      }
    }
    for (const [id, el] of this.markers) {
      if (!live.has(id)) {
        el.remove()
        this.markers.delete(id)
      }
    }
    this.bracketPositions.set(pts)
    const attr = this.brackets.geometry.getAttribute('position') as THREE.BufferAttribute
    attr.needsUpdate = true
    this.brackets.geometry.setDrawRange(0, pts.length / 3)
    this.linkPositions.set(links)
    const lattr = this.links.geometry.getAttribute('position') as THREE.BufferAttribute
    lattr.needsUpdate = true
    this.links.geometry.setDrawRange(0, links.length / 3)
    this.selection.visible = sel !== null
    if (sel) {
      this.selection.position.set(sel.x, sel.y, sel.z)
      this.selection.scale.set(sel.length + 0.3, sel.width + 0.3, sel.height + 0.3)
      this.selection.rotation.z = sel.yaw
    }
  }

  /**
   * A numbered scene marker standing on the object. Markers are keyed by track,
   * so each one keeps its element and drops in once, when the track is confirmed.
   */
  private placeMarker(id: number, x: number, y: number, z: number, selected: boolean): void {
    let el = this.markers.get(id)
    if (!el) {
      el = document.createElement('span')
      el.className = 'marker'
      el.innerHTML = '<span class="marker__tent"></span>'
      this.labels.appendChild(el)
      this.markers.set(id, el)
    }
    const s = this.project(x, y, z)
    const exhibit = this.exhibitOf(id)
    // Only logged exhibits carry a marker; a box alone means the track is still being confirmed.
    el.hidden = !s || exhibit === undefined
    if (!s || exhibit === undefined) return
    const n = String(exhibit)
    const tent = el.firstElementChild as HTMLElement
    if (tent.textContent !== n) tent.textContent = n
    el.classList.toggle('is-selected', selected)
    el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px)`
  }
}

export function trackName(id: number): string {
  return `T-${String(id).padStart(2, '0')}`
}

/** A low-poly vehicle under the pod, so the sensor is mounted on something real. */
function buildVehicle(): THREE.Group {
  const car = new THREE.Group()
  const paint = new THREE.MeshStandardMaterial({
    color: 0x3d424a,
    metalness: 0.22,
    roughness: 0.62,
    emissive: 0x0b0d10,
    emissiveIntensity: 0.5,
  })
  const trim = new THREE.MeshStandardMaterial({ color: 0x15171b, metalness: 0.3, roughness: 0.8 })
  const glass = new THREE.MeshStandardMaterial({ color: 0x0a1417, metalness: 0.8, roughness: 0.22 })
  const rubber = new THREE.MeshStandardMaterial({ color: 0x0a0c0c, metalness: 0.1, roughness: 0.95 })
  const hub = new THREE.MeshStandardMaterial({ color: 0x6f7774, metalness: 0.8, roughness: 0.35 })
  const tail = new THREE.MeshBasicMaterial({ color: 0xb03428 })
  const head = new THREE.MeshBasicMaterial({ color: 0xe4d3a8 })
  const amber = new THREE.MeshBasicMaterial({ color: 0xf2a51f })

  const body = new THREE.Mesh(new RoundedBoxGeometry(4.3, 1.78, 0.66, 4, 0.14), paint)
  body.position.z = 0.62
  car.add(body)

  const skirt = new THREE.Mesh(new RoundedBoxGeometry(4.36, 1.82, 0.26, 3, 0.08), trim)
  skirt.position.z = 0.34
  car.add(skirt)

  const cabin = new THREE.Mesh(new RoundedBoxGeometry(2.42, 1.56, 0.6, 4, 0.18), glass)
  cabin.position.set(-0.28, 0, 1.16)
  car.add(cabin)

  const roof = new THREE.Mesh(new RoundedBoxGeometry(2.05, 1.44, 0.1, 3, 0.05), paint)
  roof.position.set(-0.28, 0, 1.47)
  car.add(roof)

  for (const x of [1.36, -1.42]) {
    for (const y of [-0.86, 0.86]) {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.26, 18), rubber)
      wheel.rotation.x = Math.PI / 2
      wheel.position.set(x, y, 0.34)
      car.add(wheel)
      // A light hub catches the key light, so the wheels read at chase distance.
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.28, 12), hub)
      cap.rotation.x = Math.PI / 2
      cap.position.set(x, y, 0.34)
      car.add(cap)
    }
  }

  const bumperF = new THREE.Mesh(new RoundedBoxGeometry(0.34, 1.8, 0.32, 2, 0.07), trim)
  bumperF.position.set(2.14, 0, 0.55)
  car.add(bumperF)
  const bumperR = bumperF.clone()
  bumperR.position.x = -2.14
  car.add(bumperR)

  // A roof rack carries the pod; the rails also catch the beam at close range.
  for (const y of [-0.58, 0.58]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.05, 0.05), trim)
    rail.position.set(-0.2, y, 1.55)
    car.add(rail)
  }

  // Amber beacons at the rack corners and a low bar on the tailgate: survey
  // vehicles are lit like plant, not like passenger cars.
  for (const x of [0.84, -1.24]) {
    for (const y of [-0.62, 0.62]) {
      const beacon = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.09, 0.06), amber)
      beacon.position.set(x, y, 1.6)
      car.add(beacon)
    }
  }
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.96, 0.045), amber)
  bar.position.set(-2.17, 0, 1.02)
  car.add(bar)

  // Reflective side strips: two bright bars that give the flank its length.
  for (const y of [-0.902, 0.902]) {
    const strip = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.02, 0.075), head)
    strip.position.set(0.1, y, 0.55)
    car.add(strip)
  }

  for (const y of [-0.62, 0.62]) {
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.34, 0.12), tail)
    lamp.position.set(-2.19, y, 0.74)
    car.add(lamp)
  }
  for (const y of [-0.66, 0.66]) {
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.24, 0.1), head)
    lamp.position.set(2.19, y, 0.74)
    car.add(lamp)
  }

  // A radio whip at the rear corner breaks the boxy silhouette.
  const whip = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.014, 1.35, 6), trim)
  whip.position.set(-2.0, 0.62, 1.28)
  whip.rotation.x = 0.06
  car.add(whip)
  const whip2 = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.011, 0.95, 6), trim)
  whip2.position.set(-1.2, -0.66, 1.5)
  whip2.rotation.x = -0.05
  car.add(whip2)

  // Brush bar and side steps give the vehicle a plant-vehicle stance, and a
  // spare wheel on the tailgate kills the smooth box of the body.
  for (const y of [-0.56, 0.56]) {
    const upright = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.78, 10), trim)
    upright.position.set(2.3, y, 0.7)
    car.add(upright)
  }
  for (const z of [0.44, 0.92]) {
    const crossbar = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 1.62, 10), trim)
    crossbar.rotation.x = Math.PI / 2
    crossbar.position.set(2.3, 0, z)
    car.add(crossbar)
  }
  for (const y of [-0.98, 0.98]) {
    const step = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.11, 0.08), trim)
    step.position.set(-0.1, y, 0.3)
    car.add(step)
  }
  const spare = new THREE.Mesh(new THREE.CylinderGeometry(0.37, 0.37, 0.24, 20), rubber)
  spare.rotation.x = Math.PI / 2
  spare.position.set(-2.25, 0, 0.78)
  car.add(spare)
  const spareHub = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.26, 12), hub)
  spareHub.rotation.x = Math.PI / 2
  spareHub.position.set(-2.25, 0, 0.78)
  car.add(spareHub)

  // Roof equipment: a hard case aft of the pod and a compact radar head ahead.
  const caseBox = new THREE.Mesh(new RoundedBoxGeometry(1.02, 1.2, 0.34, 3, 0.06), trim)
  caseBox.position.set(-1.42, 0, 1.72)
  car.add(caseBox)
  for (const x of [-1.78, -1.06]) {
    const latch = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.03), hub)
    latch.position.set(x, 0.5, 1.72)
    car.add(latch)
  }
  const radar = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.34, 0.13), trim)
  radar.position.set(1.12, 0, 1.66)
  car.add(radar)
  const radarEye = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.05, 12), tail)
  radarEye.rotation.z = Math.PI / 2
  radarEye.position.set(1.24, 0, 1.66)
  car.add(radarEye)

  // Snorkel up the right A-pillar: a silhouette detail that reads at distance.
  const snorkel = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.95, 10), trim)
  snorkel.position.set(0.96, 0.86, 1.02)
  car.add(snorkel)
  const snorkelHead = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.16, 10), trim)
  snorkelHead.position.set(0.96, 0.86, 1.55)
  car.add(snorkelHead)

  // The pod's mounting plate, between the roof and the drum.
  const plate = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.48, 0.05, 24), trim)
  plate.position.z = 1.6
  car.add(plate)

  car.position.z = 0.08
  return car
}

function cross(out: number[], x: number, y: number, z: number, r: number): void {
  out.push(x - r, y, z, x + r, y, z)
  out.push(x, y - r, z, x, y + r, z)
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

/** Eight corner brackets: a tracking volume that reads as a reticle, not a crate. */
function pushBrackets(
  out: number[], cx: number, cy: number, cz: number,
  l: number, w: number, h: number, yaw: number,
): void {
  const c = Math.cos(yaw), s = Math.sin(yaw)
  const hx = l / 2, hy = w / 2, hz = h / 2
  const bx = Math.min(hx * 0.55, 0.55)
  const by = Math.min(hy * 0.55, 0.55)
  const bz = Math.min(hz * 0.55, 0.55)
  for (let i = 0; i < 8; i++) {
    const u = i & 1 ? hx : -hx, v = i & 2 ? hy : -hy, z = cz + (i & 4 ? hz : -hz)
    const px = cx + u * c - v * s, py = cy + u * s + v * c
    const sx = (i & 1 ? -bx : bx) * c, sy = (i & 1 ? -bx : bx) * s
    out.push(px, py, z, px + sx, py + sy, z)
    const uy = i & 2 ? -by : by
    out.push(px, py, z, px - uy * s, py + uy * c, z)
    out.push(px, py, z, px, py, z + (i & 4 ? -bz : bz))
  }
}
