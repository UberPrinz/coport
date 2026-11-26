import assert from 'node:assert/strict'
import test from 'node:test'
import { orderMatchedSiblings } from '../../../tabby-core/src/api/selector.ts'
import { formatSerialPorts, serialPortWeight } from '../../../tabby-serial/src/services/serialPorts.ts'

test('prefers WCH and annotates the corresponding Apple port', () => {
    const input = [
        { path: '/dev/cu.usbserial-1130', manufacturer: 'Apple' },
        { path: '/dev/cu.usbserial-9999' },
        { path: '/dev/cu.wchusbserial1130', manufacturer: 'WCH' },
    ]
    assert.deepEqual(formatSerialPorts(input), [
        { name: '/dev/cu.wchusbserial1130', description: 'WCH' },
        { name: '/dev/cu.usbserial-1130', description: 'Apple · 苹果驱动，高波特率可能失真' },
        { name: '/dev/cu.usbserial-9999', description: undefined },
    ])
})

test('WCH remains first in filtered results without moving unrelated profiles', () => {
    const apple = { name: 'Apple', weight: -1, searchOrderGroup: '1130', searchOrderPriority: 1 }
    const wch = { name: 'WCH', weight: serialPortWeight('/dev/cu.wchusbserial1130'), searchOrderGroup: '1130', searchOrderPriority: 0 }
    const ssh = { name: 'Unrelated SSH profile' }
    const options = [apple, ssh, wch]
    orderMatchedSiblings(options)
    assert.deepEqual(options, [wch, ssh, apple])
})
