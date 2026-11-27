import { Injectable } from '@angular/core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { MenuItemOptions, PlatformService, TranslateService, HostAppService, Platform } from 'tabby-core'
import { SFTPFile } from './session/sftp'
import { FileBackend } from './api/fileBackend'
import { SFTPContextMenuItemProvider } from './api'
import { SFTPDeleteModalComponent } from './components/sftpDeleteModal.component'
import { SFTPPanelComponent } from './components/sftpPanel.component'


/** @hidden */
@Injectable()
export class CommonSFTPContextMenu extends SFTPContextMenuItemProvider {
    weight = 10

    constructor (
        private platform: PlatformService,
        private ngbModal: NgbModal,
        private translate: TranslateService,
        private hostApp: HostAppService,
    ) {
        super()
    }

    async getItems (item: SFTPFile, panel: SFTPPanelComponent): Promise<MenuItemOptions[]> {
        const backend = panel.sftp
        const epoch = panel.sessionEpoch
        const items: MenuItemOptions[] = [
            {
                click: async () => {
                    if (!panel.isSessionActive(epoch, backend)) {
                        return
                    }
                    await panel.openCreateDirectoryModal(backend, epoch)
                },
                label: this.translate.instant('Create directory'),
            },
        ]

        // Add download folder option for directories (only in electron)
        if (item.isDirectory && this.hostApp.platform !== Platform.Web) {
            items.push({
                click: () => {
                    if (!panel.isSessionActive(epoch, backend)) {
                        return
                    }
                    return panel.downloadFolder(item, backend, epoch)
                },
                label: this.translate.instant('Download directory'),
            })
        }

        if (!item.isDirectory) {
            items.push({
                click: () => {
                    if (!panel.isSessionActive(epoch, backend)) {
                        return
                    }
                    return panel.downloadItem(item, backend, epoch)
                },
                label: this.translate.instant('Download'),
            })
        }

        items.push({
            click: async () => {
                if (!panel.isSessionActive(epoch, backend)) {
                    return
                }
                if ((await this.platform.showMessageBox({
                    type: 'warning',
                    message: this.translate.instant('Delete {fullPath}?', item),
                    defaultId: 0,
                    cancelId: 1,
                    buttons: [
                        this.translate.instant('Delete'),
                        this.translate.instant('Cancel'),
                    ],
                })).response === 0) {
                    if (!panel.isSessionActive(epoch, backend)) {
                        return
                    }
                    await this.deleteItem(item, backend, panel, epoch)
                    if (panel.isSessionActive(epoch, backend)) {
                        void panel.navigate(panel.path)
                    }
                }
            },
            label: this.translate.instant('Delete'),
        })

        return items
    }

    async deleteItem (
        item: SFTPFile,
        session: FileBackend,
        panel?: SFTPPanelComponent,
        epoch?: number,
    ): Promise<void> {
        if (panel && epoch !== undefined && !panel.isSessionActive(epoch, session)) {
            return
        }
        const modal = this.ngbModal.open(SFTPDeleteModalComponent)
        panel?.registerModal(modal)
        modal.componentInstance.item = item
        modal.componentInstance.sftp = session
        if (panel && epoch !== undefined) {
            modal.componentInstance.shouldContinue = () => panel.isSessionActive(epoch, session)
        }
        await modal.result.catch(() => null)
    }
}
