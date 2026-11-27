import { Injectable } from '@angular/core'
import WSABinding from 'serialport-binding-webserialapi'
import AbstractBinding from '@serialport/binding-abstract'
import { autoDetect } from '@serialport/bindings-cpp'
import { HostAppService, Platform } from 'tabby-core'
import { SerialPortInfo } from '../api'
import { formatSerialPorts } from './serialPorts'

@Injectable({ providedIn: 'root' })
export class SerialService {
    private constructor (
        private hostApp: HostAppService,
    ) { }

    detectBinding (): typeof AbstractBinding {
        return this.hostApp.platform === Platform.Web ? WSABinding : autoDetect()
    }

    async listPorts (): Promise<SerialPortInfo[]> {
        try {
            return formatSerialPorts(await this.detectBinding().list()) // coport: WCH preference.
        } catch (err) {
            console.error('Failed to list serial ports', err)
            return []
        }
    }
}
