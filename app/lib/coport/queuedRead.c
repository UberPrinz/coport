#include <node_api.h>
#include <sys/event.h>
#include <sys/ioctl.h>
#include <time.h>
#include <unistd.h>

static napi_value queued_read_bytes(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1], result;
    int32_t fd;
    int count;
    if (napi_get_cb_info(env, info, &argc, args, 0, 0) != napi_ok
        || argc != 1 || napi_get_value_int32(env, args[0], &fd) != napi_ok
        || ioctl(fd, FIONREAD, &count) != 0) {
        napi_throw_error(env, 0, "FIONREAD failed");
        return 0;
    }
    napi_create_int32(env, count, &result);
    return result;
}

static napi_value peer_uid(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1], result;
    int32_t fd;
    uid_t uid;
    gid_t gid;
    if (napi_get_cb_info(env, info, &argc, args, 0, 0) != napi_ok
        || argc != 1 || napi_get_value_int32(env, args[0], &fd) != napi_ok
        || getpeereid(fd, &uid, &gid) != 0) {
        napi_get_null(env, &result);
        return result;
    }
    napi_create_uint32(env, uid, &result);
    return result;
}

// EVFILT_READ reports EV_EOF even if libuv has paused reading queued bytes.
static napi_value peer_ended(napi_env env, napi_callback_info info) {
    size_t argc = 1;
    napi_value args[1], result;
    int32_t fd;
    bool ended = true;
    if (napi_get_cb_info(env, info, &argc, args, 0, 0) == napi_ok
        && argc == 1 && napi_get_value_int32(env, args[0], &fd) == napi_ok) {
        int queue = kqueue();
        if (queue >= 0) {
            struct kevent watch, event;
            struct timespec now = {0};
            EV_SET(&watch, fd, EVFILT_READ, EV_ADD | EV_ONESHOT, 0, 0, NULL);
            int count = kevent(queue, &watch, 1, &event, 1, &now);
            ended = count < 0 || (count == 1 && (event.flags & (EV_EOF | EV_ERROR)));
            close(queue);
        }
    }
    napi_get_boolean(env, ended, &result);
    return result;
}

NAPI_MODULE_INIT() {
    napi_value fn;
    napi_create_function(env, "queuedReadBytes", NAPI_AUTO_LENGTH, queued_read_bytes, 0, &fn);
    napi_set_named_property(env, exports, "queuedReadBytes", fn);
    napi_create_function(env, "peerUid", NAPI_AUTO_LENGTH, peer_uid, 0, &fn);
    napi_set_named_property(env, exports, "peerUid", fn);
    napi_create_function(env, "peerEnded", NAPI_AUTO_LENGTH, peer_ended, 0, &fn);
    napi_set_named_property(env, exports, "peerEnded", fn);
    return exports;
}
