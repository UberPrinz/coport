import { Directive, Input, Output, ElementRef, EventEmitter, AfterViewInit, OnDestroy } from '@angular/core'
import { DirectoryUpload, FileUpload, PlatformService } from '../api/platform'
import './dropZone.directive.scss'

function cancelUploadTree (transfer: DirectoryUpload, handled = new Set<FileUpload>()): void {
    for (const child of transfer.getChildrens()) {
        if (child instanceof DirectoryUpload) {
            cancelUploadTree(child, handled)
        } else if (!handled.has(child)) {
            handled.add(child)
            if (!child.isCancelled()) {
                child.cancel()
            }
        }
    }
}

/** @hidden */
@Directive({
    selector: '[dropZone]',
})
export class DropZoneDirective implements AfterViewInit, OnDestroy {
    @Output() transfer = new EventEmitter<DirectoryUpload>()
    // coport: Capture the destination context before an asynchronous directory scan.
    @Input() dropTarget?: () => any
    @Output() transferAt = new EventEmitter<{ upload: DirectoryUpload, target?: any }>()
    private dropHint?: HTMLElement
    private destroyed = false

    private readonly handleDragOver = (): void => {
        if (this.destroyed) {
            return
        }
        if (!this.dropHint) {
            this.dropHint = document.createElement('div')
            this.dropHint.className = 'drop-zone-hint'
            this.dropHint.innerHTML = require('./dropZone.directive.pug')
            this.el.nativeElement.appendChild(this.dropHint)
            setTimeout(() => {
                this.dropHint?.classList.add('visible')
            })
        }
    }

    private canAcceptDrop (): boolean {
        return !this.destroyed && (this.transferAt.observed || this.transfer.observed)
    }

    private readonly handleDrop = async (event: DragEvent): Promise<void> => {
        if (this.destroyed) {
            return
        }
        const target = this.dropTarget?.()
        this.removeHint()
        const canAccept = () => this.canAcceptDrop()
        try {
            const upload = await this.platform.startUploadFromDragEvent(event, true, canAccept)
            if (!canAccept()) {
                cancelUploadTree(upload)
                return
            }
            this.transfer.emit(upload)
            this.transferAt.emit({ upload, target })
        } catch (error) {
            if (canAccept()) {
                console.error(error)
            }
        }
    }

    private readonly handleDragLeave = (): void => {
        this.removeHint()
    }

    constructor (
        private el: ElementRef,
        private platform: PlatformService,
    ) { }

    ngAfterViewInit (): void {
        this.el.nativeElement.addEventListener('dragover', this.handleDragOver)
        this.el.nativeElement.addEventListener('drop', this.handleDrop)
        this.el.nativeElement.addEventListener('dragleave', this.handleDragLeave)
    }

    ngOnDestroy (): void {
        this.destroyed = true
        this.removeHint()
        this.el.nativeElement.removeEventListener('dragover', this.handleDragOver)
        this.el.nativeElement.removeEventListener('drop', this.handleDrop)
        this.el.nativeElement.removeEventListener('dragleave', this.handleDragLeave)
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
