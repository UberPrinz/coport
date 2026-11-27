import { Component, Input } from '@angular/core'
import { TerminalTabComponent } from 'tabby-local'
import { ADB_FILE_PANEL_SCOPE } from 'tabby-ssh'
import { AdbFileBackend } from './adbFileBackend'

@Component({
    selector: 'coport-adb-tab',
    template: TerminalTabComponent.template + require('./adbPanel.pug'),
    styles: [...TerminalTabComponent.styles, require('./adbTab.component.scss')],
    animations: TerminalTabComponent.animations,
})
export class AdbTabComponent extends TerminalTabComponent {
    @Input() serial: string
    enableToolbar = true
    showFiles = false
    remotePath = '/'
    readonly fileStateScope = ADB_FILE_PANEL_SCOPE
    readonly defaultFilePath = '/'
    files = {
        openSFTP: async (): Promise<AdbFileBackend> => new AdbFileBackend(this.serial),
    }

    async getRecoveryToken (): Promise<null> {
        return null
    }
}
