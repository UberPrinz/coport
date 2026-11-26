#include <node_api.h>
#include <sys/ioctl.h>

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

NAPI_MODULE_INIT() {
    napi_value fn;
    napi_create_function(env, "queuedReadBytes", NAPI_AUTO_LENGTH, queued_read_bytes, 0, &fn);
    napi_set_named_property(env, exports, "queuedReadBytes", fn);
    return exports;
}
