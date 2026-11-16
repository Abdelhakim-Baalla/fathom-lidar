import { describe, expect, it } from 'vitest'
import { parseCsiLine } from './serial'

describe('real USB CSI input', () => {
  it('decodes esp-csi signed IQ into measured subcarrier amplitudes', () => {
    const p = parseCsiLine('CSI_DATA,17,mac,-47,11,"[0,0,3,4,-6,8,5,12]"')!
    expect(p.rssi).toBe(-47)
    expect(Array.from(p.amp)).toEqual([0, 5, 10, 13])
  })
  it('rejects debug output, malformed samples and invalid power', () => {
    for (const line of ['booting', 'CSI_DATA,1,mac,no,"[1,2,3,4]"', 'CSI_DATA,1,mac,-40,"[1,2,3]"', 'CSI_DATA,1,mac,-40,"[1,2,NaN,4]"', 'CSI_DATA,1,mac,-40,"[256,2,3,4]"']) expect(parseCsiLine(line)).toBeNull()
  })
})
