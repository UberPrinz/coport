import { Injectable, NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import TabbyCoreModule, { NewTabParameters, NotificationsService, PartialProfile, Profile, ProfileProvider, SelectorService } from 'tabby-core'
import type { LocalProfile } from 'tabby-local'
import TabbySSHModule from 'tabby-ssh'
import TabbyTerminalModule from 'tabby-terminal'
import { adbRequest } from './adbFileBackend'
import { AdbTabComponent } from './adbTab.component'

interface Device {
    serial: string
    status: string
}

interface AdbProfile extends Profile {
    options: { serial: string | null }
}

@Injectable({ providedIn: 'root' })
export class AdbProfiles extends ProfileProvider<AdbProfile> {
    id = 'coport-adb'
    name = 'Coport ADB Shell'
    configDefaults = { options: { serial: null } }

    constructor (private selector: SelectorService, private notices: NotificationsService) {
        super()
    }

    async getBuiltinProfiles (): Promise<PartialProfile<AdbProfile>[]> {
        return [{ id: 'coport-adb:shell', type: this.id, name: this.name, isBuiltin: true, icon: 'fab fa-android' }]
    }

    getDescription (profile: PartialProfile<AdbProfile>): string {
        return profile.options?.serial ?? 'Android device shell'
    }

    async getNewTabParameters (profile: AdbProfile): Promise<NewTabParameters<AdbTabComponent> | null> {
        try {
            let serial = profile.options.serial
            if (!serial) {
                const devices = await adbRequest<Device[]>('devices')
                const authorized = devices.filter(device => device.status === 'device')
                if (!devices.length) {
                    throw new Error('No ADB device connected')
                }
                if (authorized.length === 1) {
                    serial = authorized[0].serial
                } else {
                    serial = await this.selector.show('Select Android device', devices.map(device => ({
                        name: device.serial, description: device.status, result: device.serial,
                    }))).catch(() => null)
                }
            }
            if (!serial) {
                return null
            }
            const { path, serverArgs } = await adbRequest<{ path: string, serverArgs: string[] }>('select', { serial })
            const terminalProfile: LocalProfile = {
                ...profile,
                terminalColorScheme: null,
                options: {
                    command: path, args: [...serverArgs, '-s', serial, 'shell'], homeDirArgs: [], cwd: null,
                    env: {}, width: null, height: null, shellType: null, fsBase: null,
                    restoreFromPTYID: null, pauseAfterExit: false, runAsAdministrator: false,
                },
            }
            return { type: AdbTabComponent, inputs: { profile: terminalProfile, serial } }
        } catch (error) {
            this.notices.error(error.message)
            return null
        }
    }
}

@NgModule({
    imports: [CommonModule, TabbyCoreModule, TabbySSHModule, TabbyTerminalModule],
    declarations: [AdbTabComponent],
    providers: [{ provide: ProfileProvider, useExisting: AdbProfiles, multi: true }],
})
export default class TabbyAdbModule { } // eslint-disable-line @typescript-eslint/no-extraneous-class
