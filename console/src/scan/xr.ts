/// <reference types="webxr" />
import { allocFrame, finishFrame, FLAG_REVOLUTION_END, FLAG_SCAN, writePoint } from '../protocol/frame'

/**
 * A room scan from an Android phone through WebXR depth sensing (ARCore).
 *
 * Each AR frame gives a small depth image for the camera view. Its pixels are
 * unprojected with the view's projection matrix, placed in the room with the
 * phone's tracked pose, thinned on a 2 cm voxel grid so the same surface is not
 * stored twice, and sent on as FTHM frames with the scan flag: the console keeps
 * every point and does not try to track objects in a still room.
 *
 * Depth comes from ARCore. On most phones it is estimated from motion and the
 * camera image, not measured by a time-of-flight sensor; the console says so.
 */

const VOXEL = 0.02
const STRIDE = 2
const MAX_DEPTH = 6
/** depth rows mapped onto rings, so the range image shows the phone's own view */
const RINGS = 64

export interface ScanStats {
  points: number
  frames: number
  depthWidth: number
  depthHeight: number
  /** metres the phone has moved since the scan began */
  travelled: number
}

/**
 * Turn one depth image into world points (x forward, y left, z up) and the sensor pose.
 * `depthAt(u, v)` takes normalised view coordinates, 0,0 at the top left.
 * `proj` and `view` are column-major 4×4 matrices as WebXR gives them.
 */
export function unprojectDepth(
  depthAt: (u: number, v: number) => number,
  cols: number, rows: number,
  proj: ArrayLike<number>, view: ArrayLike<number>,
  out: (x: number, y: number, z: number, row: number) => void,
): void {
  const p0 = proj[0], p5 = proj[5], p8 = proj[8], p9 = proj[9]
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const u = (c + 0.5) / cols, v = (r + 0.5) / rows
      const d = depthAt(u, v)
      if (!(d > 0.1 && d < MAX_DEPTH)) continue
      // View space: x right, y up, looking down −z. Depth is distance from the view plane.
      const nx = 2 * u - 1, ny = 1 - 2 * v
      const vx = ((nx + p8) * d) / p0
      const vy = ((ny + p9) * d) / p5
      const vz = -d
      // To the reference space (y up)…
      const wx = view[0] * vx + view[4] * vy + view[8] * vz + view[12]
      const wy = view[1] * vx + view[5] * vy + view[9] * vz + view[13]
      const wz = view[2] * vx + view[6] * vy + view[10] * vz + view[14]
      // …and to Fathom's frame: x forward (−z), y left (−x), z up (y).
      out(-wz, -wx, wy, r)
    }
  }
}

/** Phone pose in Fathom's frame from a WebXR view matrix. */
export function poseOf(view: ArrayLike<number>): { x: number; y: number; z: number; yaw: number } {
  // The camera looks down its −z axis; in reference space that direction is −(column 2).
  const fx = -view[8], fz = -view[10]
  return { x: -view[14], y: -view[12], z: view[13], yaw: Math.atan2(fx * -1, -fz) }
}

export class PhoneScan {
  onFrame: (buffer: ArrayBuffer) => void = () => {}
  onEnd: () => void = () => {}
  onStats: (s: ScanStats) => void = () => {}
  stats: ScanStats = { points: 0, frames: 0, depthWidth: 0, depthHeight: 0, travelled: 0 }

  private session: XRSession | null = null
  private ref: XRReferenceSpace | null = null
  private gl: WebGLRenderingContext | null = null
  private voxels = new Set<number>()
  private frameId = 0
  private t0 = 0
  private start: { x: number; y: number; z: number } | null = null
  private lastEmit = 0

  static async supported(): Promise<boolean> {
    try {
      return !!navigator.xr && (await navigator.xr.isSessionSupported('immersive-ar'))
    } catch {
      return false
    }
  }

  async begin(overlay: HTMLElement): Promise<string | null> {
    if (!navigator.xr) return 'This browser has no WebXR. Use Chrome on an ARCore phone, over HTTPS.'
    let session: XRSession
    try {
      session = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['depth-sensing', 'local'],
        optionalFeatures: ['dom-overlay'],
        domOverlay: { root: overlay },
        depthSensing: { usagePreference: ['cpu-optimized'], dataFormatPreference: ['luminance-alpha', 'float32'] },
      } as XRSessionInit)
    } catch (err) {
      return `The phone refused the AR session: ${(err as Error).message}. Depth sensing needs an ARCore phone with depth support.`
    }
    this.session = session
    overlay.classList.add('is-xr-active')
    const canvas = document.createElement('canvas')
    this.gl = canvas.getContext('webgl', { xrCompatible: true }) as WebGLRenderingContext
    await session.updateRenderState({ baseLayer: new XRWebGLLayer(session, this.gl) })
    this.ref = await session.requestReferenceSpace('local')
    this.voxels.clear()
    this.frameId = 0
    this.start = null
    this.t0 = performance.now()
    this.stats = { points: 0, frames: 0, depthWidth: 0, depthHeight: 0, travelled: 0 }
    session.addEventListener('end', () => {
      this.session = null
      overlay.classList.remove('is-xr-active')
      this.onEnd()
    })
    session.requestAnimationFrame(this.frame)
    return null
  }

  end(): void {
    this.session?.end()
  }

  private frame = (_time: number, frame: XRFrame): void => {
    const session = frame.session
    session.requestAnimationFrame(this.frame)
    const layer = session.renderState.baseLayer!
    const gl = this.gl!
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)

    const pose = frame.getViewerPose(this.ref!)
    const now = performance.now()
    // Ten scans a second is plenty for a walking operator and keeps the phone cool.
    if (!pose || now - this.lastEmit < 100) return
    this.lastEmit = now
    const view = pose.views[0]
    const depth = frame.getDepthInformation(view) as XRCPUDepthInformation | undefined
    if (!depth) return

    const m = view.transform.matrix
    const sensor = poseOf(m)
    if (!this.start) this.start = { x: sensor.x, y: sensor.y, z: sensor.z }
    const cols = Math.floor(depth.width / STRIDE), rows = Math.floor(depth.height / STRIDE)
    this.stats.depthWidth = depth.width
    this.stats.depthHeight = depth.height
    this.stats.travelled = Math.hypot(sensor.x - this.start.x, sensor.y - this.start.y, sensor.z - this.start.z)

    const f = allocFrame(cols * rows)
    let n = 0
    const c = Math.cos(-sensor.yaw), s = Math.sin(-sensor.yaw)
    unprojectDepth((u, v) => depth.getDepthInMeters(u, v), cols, rows, view.projectionMatrix, m, (x, y, z, row) => {
      const key = Math.round(x / VOXEL) + 4096 * (Math.round(y / VOXEL) + 4096 * Math.round(z / VOXEL))
      if (this.voxels.has(key)) return
      this.voxels.add(key)
      // Frames carry points in the sensor frame; the console puts them back in the room.
      const dx = x - sensor.x, dy = y - sensor.y
      const sx = c * dx - s * dy, sy = s * dx + c * dy
      const az = ((Math.atan2(sy, sx) * 18000) / Math.PI + 36000) % 36000
      writePoint(f, n++, sx, sy, z - sensor.z, 120, RINGS - 1 - Math.min(RINGS - 1, Math.floor((row / rows) * RINGS)), az)
    })
    this.stats.points += n
    this.stats.frames++
    const buf = finishFrame(f, {
      flags: FLAG_SCAN | FLAG_REVOLUTION_END, frameId: this.frameId++, pointCount: n,
      timestamp: (now - this.t0) / 1000, ...sensor,
    })
    this.onFrame(buf)
    this.onStats(this.stats)
  }
}
