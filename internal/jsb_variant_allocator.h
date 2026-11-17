#ifndef GODOTJS_VARIANT_ALLOCATOR_H
#define GODOTJS_VARIANT_ALLOCATOR_H

#include "jsb_internal_pch.h"
#include "jsb_macros.h"
#include <atomic>
#include <vector>

namespace jsb::internal
{
    class VariantAllocator
    {
        bool use_front_ = true;
        Vector<Variant*> front_;
        Vector<Variant*> back_;
        SpinLock spin_lock_;
        // The intrusive metadata shares each paged allocation with its Variant.
        // Native math values do not allocate a separate tracking node.
        struct Cell : Variant { Cell* previous = nullptr; Cell* next = nullptr; };
        Cell* first_live_ = nullptr;
        size_t live_count_ = 0;
        std::atomic<bool> sealed_{false};

#if JSB_DEBUG
        SafeNumeric<uint32_t> alive_variants_num_;
#endif

#if JSB_WITH_V8 || JSB_WITH_JAVASCRIPTCORE
        // v8 and jsc implementation of deleter are probably called from JS gc threads
        // so we need thread-safe version
        PagedAllocator<Cell, true> paged_allocator_;
#else
        // web and quickjs implementation of deleter are called from owner thread only
        PagedAllocator<Cell, false> paged_allocator_;
#endif

    public:
#if JSB_DEBUG
        jsb_force_inline uint32_t get_allocated_num() const { return alive_variants_num_.get(); }
#else
        // intentionally ignored in release mode
        jsb_force_inline uint32_t get_allocated_num() const { return 0; }
#endif

#if JSB_DEBUG
        ~VariantAllocator()
        {
            spin_lock_.lock();
            jsb_notice(front_.is_empty() && back_.is_empty(), "the pending queue is not empty");
            spin_lock_.unlock();
            jsb_notice(get_allocated_num() == 0, "variant pool leaked");
        }
#endif

        jsb_force_inline Variant* alloc(const Variant& p_templet)
        {
            Variant* rval = alloc();
            *rval = p_templet;
            return rval;
        }

        jsb_force_inline Variant* alloc()
        {
            jsb_check(!is_sealed());
            Cell* cell = paged_allocator_.alloc();
            spin_lock_.lock();
            cell->next = first_live_;
            if (first_live_) first_live_->previous = cell;
            first_live_ = cell; ++live_count_;
            spin_lock_.unlock();
            increment(); return cell;
        }

        bool is_sealed() const { return sealed_.load(std::memory_order_acquire); }

        // Owner thread only. Move leaves every still-live cell as NIL, so its
        // late VM deleter can free the cell exactly once. No Ref destructor or
        // native callback runs under the registry lock.
        void seal_payloads()
        {
            std::vector<Variant> retired;
            spin_lock_.lock();
            sealed_.store(true, std::memory_order_release);
            retired.reserve(live_count_);
            for (Cell* cell = first_live_; cell; cell = cell->next)
                retired.emplace_back(std::move(static_cast<Variant&>(*cell)));
            spin_lock_.unlock();
        }

        //NOTE safe to call from other threads only if p_var is not reference-based type
        jsb_force_inline void free(Variant* p_var)
        {
            Cell* cell = static_cast<Cell*>(p_var);
            spin_lock_.lock();
            if (cell->previous) cell->previous->next = cell->next;
            else { jsb_check(first_live_ == cell); first_live_ = cell->next; }
            if (cell->next) cell->next->previous = cell->previous;
            --live_count_;
            spin_lock_.unlock();
            decrement(); paged_allocator_.free(cell);
        }

        // gc thread
        void free_safe(Variant* p_var)
        {
            spin_lock_.lock();
            if (use_front_) front_.push_back(p_var);
            else back_.push_back(p_var);
            spin_lock_.unlock();
        }

        // should only be called on owner thread
        void drain()
        {
            spin_lock_.lock();
            Vector<Variant*>& queue = use_front_ ? front_ : back_;
            use_front_ = !use_front_;
            spin_lock_.unlock();

            if (!queue.is_empty())
            {
                for (Variant* variant : queue)
                {
                    free(variant);
                }
                queue.clear();
            }
        }

    private:
#if JSB_DEBUG
        jsb_force_inline void increment() { alive_variants_num_.increment(); }
        jsb_force_inline void decrement() { alive_variants_num_.decrement(); }
#else
        jsb_force_inline void increment() {}
        jsb_force_inline void decrement() {}
#endif
    };
}

#endif
