#include <stdio.h>
#include <emscripten/emscripten.h>
#include <emscripten/threading.h>
int main(void) {
    printf("PTHREAD_BROWSER_MAIN %d\n", emscripten_is_main_browser_thread());
    EM_ASM({ console.log('PTHREAD_MEMORY ' + JSON.stringify({worker:self instanceof WorkerGlobalScope, shared:HEAPU8.buffer instanceof SharedArrayBuffer, memoryTag:Object.prototype.toString.call(HEAPU8.buffer)})); });
    return 0;
}
