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
    shouldContinue?: () => boolean
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

    private isStopped (): boolean {
        if (this.cancelled) {
            return true
        }
        if (this.shouldContinue && !this.shouldContinue()) {
            this.cancelled = true
            return true
        }
        return false
    }

    async run (file: SFTPFile): Promise<void> {
        if (this.isStopped()) {
            return
        }
        this.progressMessage = file.fullPath

        if (file.isDirectory) {
            const children = await this.sftp.readdir(file.fullPath)
            if (this.isStopped()) {
                return
            }
            for (const child of children) {
                await this.run(child)
                if (this.isStopped()) {
                    break
                }
            }
            if (!this.isStopped()) {
                await this.sftp.rmdir(file.fullPath)
            }
        } else {
            await this.sftp.unlink(file.fullPath)
        }
    }
}
