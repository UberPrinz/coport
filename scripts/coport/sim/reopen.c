#include <ApplicationServices/ApplicationServices.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
    if (argc != 2) return 2;
    pid_t pid = (pid_t)strtol(argv[1], NULL, 10);
    if (pid <= 1) return 2;
    AEAddressDesc target = {typeNull, NULL};
    AppleEvent event = {typeNull, NULL};
    OSStatus status = AECreateDesc(typeKernelProcessID, &pid, sizeof(pid), &target);
    if (!status) {
        status = AECreateAppleEvent(kCoreEventClass, kAEReopenApplication, &target,
                                    kAutoGenerateReturnID, kAnyTransactionID, &event);
    }
    if (!status) status = AESendMessage(&event, NULL, kAENoReply | kAECanInteract, kAEDefaultTimeout);
    AEDisposeDesc(&event);
    AEDisposeDesc(&target);
    if (status) fprintf(stderr, "kAEReopenApplication returned %d\n", (int)status);
    return status ? 1 : 0;
}
