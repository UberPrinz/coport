import { Component } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'
import { BaseComponent, NotificationsService } from 'tabby-core'
import { SFTPFile } from '../session/sftp'
import { FileBackend } from '../api/fileBackend'

/** @hidden */
@Component({
    templateUrl: './sftpDeleteModal.component.pug',
})
export class SFTPDeleteModalComponent extends BaseComponent {
    sftp: FileBackend
    item: SFTPFile
    progressMessage = ''
    cancelled = false

    constructor (
        private modalInstance: NgbActiveModal,
        private notifications: NotificationsService,
    ) {
        super()
    }

    async ngOnInit (): Promise<void> {
        this.destroyed$.subscribe(() => this.cancel())
        try {
            await this.run(this.item)
            this.modalInstance.close()
        } catch (error) {
            this.notifications.error(error.message)
            this.modalInstance.dismiss(error)
        }
    }

    cancel (): void {
        this.cancelled = true
        this.modalInstance.close()
    }

    async run (file: SFTPFile): Promise<void> {
        this.progressMessage = file.fullPath

        if (file.isDirectory) {
            for (const child of await this.sftp.readdir(file.fullPath)) {
                await this.run(child)
                if (this.cancelled) {
                    break
                }
            }
            if (!this.cancelled) {
                await this.sftp.rmdir(file.fullPath)
            }
        } else {
            await this.sftp.unlink(file.fullPath)
        }
    }
}
