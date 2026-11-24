#ifndef JSB_RUNTIME_GAME_PROBE_H
#define JSB_RUNTIME_GAME_PROBE_H

#include "core/templates/rid.h"
#include <cstdint>

namespace jsb::game_probe {

void arm_draw();
bool take_draw();

class DrawScope {
    bool previous;
public:
    DrawScope();
    ~DrawScope();
    void enable(bool enabled);
};

class ViewportScope {
    bool previous_root;
    bool previous_blit;
public:
    ViewportScope(RID viewport, bool main_window);
    ~ViewportScope();
};

void complete_blit();
void reject_direct_to_screen(RID viewport);
void begin_iteration();
void commit(uint32_t iteration, uint32_t serial, bool own_context);
void end_iteration(uint32_t iteration, bool exiting);
uint32_t stage(uint32_t size, uint32_t remaining_us);
uint32_t take();
void clear();

} // namespace jsb::game_probe

#endif
