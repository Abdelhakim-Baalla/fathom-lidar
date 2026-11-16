/** Direct ESP32 CSI input via Web Serial. No network bridge or uploaded sensor data. */
export interface CsiPacket { rssi: number; amp: Float32Array }
interface SerialPort {
  readable: ReadableStream<Uint8Array> | null
  open(options: { baudRate: number }): Promise<void>
  close(): Promise<void>
}
interface SerialAPI { requestPort(): Promise<SerialPort> }

export function parseCsiLine(line: string): CsiPacket | null {
  if (!line.startsWith('CSI_DATA,')) return null
  const start = line.indexOf('['), end = line.lastIndexOf(']')
  if (start < 0 || end <= start) return null
  const rssi = Number(line.slice(0, start).split(',')[3])
  const raw = line.slice(start + 1, end).split(',').map((v) => Number(v.trim()))
  if (!Number.isFinite(rssi) || rssi < -127 || rssi > 0 || raw.length < 4 || raw.length > 2048 || raw.length % 2) return null
  if (raw.some((v) => !Number.isInteger(v) || v < -128 || v > 127)) return null
  return { rssi, amp: Float32Array.from({ length: raw.length / 2 }, (_, i) => Math.hypot(raw[i * 2], raw[i * 2 + 1])) }
}

export class SerialCsi {
  private port: SerialPort | null = null
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  private generation = 0
  static supported(): boolean { return isSecureContext && 'serial' in navigator }
  onPacket: (packet: CsiPacket) => void = () => {}
  onStatus: (connected: boolean, message: string) => void = () => {}

  async connect(): Promise<void> {
    await this.disconnect()
    const generation = ++this.generation
    try {
      if (!SerialCsi.supported()) throw new Error('USB CSI needs Chrome or Edge on desktop, over HTTPS or localhost.')
      const api = (navigator as Navigator & { serial: SerialAPI }).serial
      const port = await api.requestPort()
      if (generation !== this.generation) return
      this.port = port
      await port.open({ baudRate: 921600 })
      if (generation !== this.generation) { await port.close(); return }
      this.onStatus(true, 'USB connected. Waiting for esp-csi packets at 921600 baud.')
      const reader = port.readable?.getReader()
      if (!reader) throw new Error('This serial port has no readable stream.')
      this.reader = reader
      const decoder = new TextDecoder()
      let pending = ''
      try {
        while (generation === this.generation) {
          const { value, done } = await reader.read()
          if (done) break
          pending += decoder.decode(value, { stream: true })
          const lines = pending.split('\n')
          pending = lines.pop() ?? ''
          if (pending.length > 32768) pending = ''
          for (const line of lines) {
            const packet = parseCsiLine(line.trim())
            if (packet && generation === this.generation) this.onPacket(packet)
          }
        }
      } finally { reader.releaseLock(); if (this.reader === reader) this.reader = null }
      if (generation === this.generation) this.onStatus(false, 'USB disconnected. Reconnect the ESP32 to resume.')
    } catch (error) {
      if (generation === this.generation) this.onStatus(false, error instanceof Error ? error.message : 'USB connection failed.')
    } finally {
      if (generation === this.generation) {
        const port = this.port
        this.port = null
        try { await port?.close() } catch { /* already detached */ }
      }
    }
  }

  async disconnect(): Promise<void> {
    this.generation++
    const reader = this.reader, port = this.port
    this.port = null
    try { await reader?.cancel() } catch { /* device removed */ }
    // read() resumes and releases its lock before this continuation.
    try { await port?.close() } catch { /* already closed */ }
  }
}
