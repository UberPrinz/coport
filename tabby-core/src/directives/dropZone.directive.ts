import { Directive, Input, Output, ElementRef, EventEmitter, AfterViewInit } from '@angular/core'
import { DirectoryUpload, PlatformService } from '../api/platform'
import './dropZone.directive.scss'

/** @hidden */
@Directive({
    selector: '[dropZone]',
})
export class DropZoneDirective implements AfterViewInit {
    @Output() transfer = new EventEmitter<DirectoryUpload>()
    // coport: Capture the destination before an asynchronous directory scan.
    @Input() dropTarget?: () => string
    @Output() transferAt = new EventEmitter<{ upload: DirectoryUpload, target?: string }>()
    private dropHint?: HTMLElement

    constructor (
        private el: ElementRef,
        private platform: PlatformService,
    ) { }

    ngAfterViewInit (): void {
        this.el.nativeElement.addEventListener('dragover', () => {
            if (!this.dropHint) {
                this.dropHint = document.createElement('div')
                this.dropHint.className = 'drop-zone-hint'
                this.dropHint.innerHTML = require('./dropZone.directive.pug')
                this.el.nativeElement.appendChild(this.dropHint)
                setTimeout(() => {
                    this.dropHint!.classList.add('visible')
                })
            }
        })
        this.el.nativeElement.addEventListener('drop', async (event: DragEvent) => {
            const target = this.dropTarget?.()
            this.removeHint()
            const upload = await this.platform.startUploadFromDragEvent(event, true)
            this.transfer.emit(upload)
            this.transferAt.emit({ upload, target })
        })
        this.el.nativeElement.addEventListener('dragleave', () => {
            this.removeHint()
        })
    }

    private removeHint () {
        const element = this.dropHint
        delete this.dropHint
        element?.classList.remove('visible')
        setTimeout(() => {
            element?.remove()
        }, 500)
    }
}
