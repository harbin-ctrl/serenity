/*
 * Copyright (c) 2018-2022, Andreas Kling <kling@serenityos.org>
 *
 * SPDX-License-Identifier: BSD-2-Clause
 */

#include <AK/Array.h>
#include <AK/BuiltinWrappers.h>
#include <AK/NumericLimits.h>
#include <AK/ScopeGuard.h>
#include <AK/Singleton.h>
#include <AK/Time.h>
#include <Kernel/Arch/TrapFrame.h>
#include <Kernel/Debug.h>
#include <Kernel/Interrupts/InterruptDisabler.h>
#include <Kernel/Library/Panic.h>
#include <Kernel/Sections.h>
#include <Kernel/Tasks/PerformanceManager.h>
#include <Kernel/Tasks/Process.h>
#include <Kernel/Tasks/Scheduler.h>
#include <Kernel/Tasks/WaitQueue.h>
#include <Kernel/Time/TimeManagement.h>
#include <Kernel/kstdio.h>

namespace Kernel {

RecursiveSpinlock<LockRank::None> g_scheduler_lock {};

// Rounded values of 1024 * 16^((priority - 1) / 98). Every priority has a
// distinct integer weight; 99 gets exactly 16 times the weight of 1. Keep
// floating point out of the scheduler and use a fixed one-tick (~4 ms) turn.
static constexpr u16 s_priority_weights[] = {
    1024, 1053, 1084, 1115, 1147, 1180, 1213, 1248, 1284,
    1321, 1359, 1398, 1438, 1479, 1522, 1565, 1610, 1656,
    1704, 1753, 1803, 1855, 1908, 1963, 2019, 2077, 2137,
    2198, 2261, 2326, 2393, 2461, 2532, 2605, 2680, 2756,
    2836, 2917, 3001, 3087, 3175, 3266, 3360, 3457, 3556,
    3658, 3763, 3871, 3982, 4096, 4214, 4334, 4459, 4587,
    4718, 4854, 4993, 5136, 5284, 5435, 5591, 5752, 5917,
    6087, 6261, 6441, 6626, 6816, 7012, 7213, 7420, 7633,
    7852, 8077, 8309, 8547, 8792, 9045, 9304, 9571, 9846,
    10128, 10419, 10718, 11026, 11342, 11667, 12002, 12347, 12701,
    13065, 13440, 13826, 14223, 14631, 15051, 15483, 15927, 16384,
};
static_assert(sizeof(s_priority_weights) / sizeof(s_priority_weights[0]) == THREAD_PRIORITY_MAX - THREAD_PRIORITY_MIN + 1);

static u16 priority_weight(Thread const& thread)
{
    VERIFY(thread.priority() >= THREAD_PRIORITY_MIN && thread.priority() <= THREAD_PRIORITY_MAX);
    return s_priority_weights[thread.priority() - THREAD_PRIORITY_MIN];
}

// Virtual time charged for one tick of running: 16384 at priority 1, 1024 at 99.
static u32 virtual_time_per_tick(Thread const& thread)
{
    return (1u << 24) / priority_weight(thread);
}

READONLY_AFTER_INIT Thread* g_finalizer;
READONLY_AFTER_INIT WaitQueue* g_finalizer_wait_queue;
SpinlockProtected<bool, LockRank::None> g_finalizer_has_work;
READONLY_AFTER_INIT static Process* s_colonel_process;

// All runnable threads share a queue. Each thread's virtual time advances
// while it runs, more slowly for higher priorities, and the runnable thread
// with the lowest virtual time runs next. Low-priority threads still progress.
struct ThreadReadyQueue {
    IntrusiveList<&Thread::m_ready_queue_node> thread_list;
    // Virtual time of the thread running on each CPU; the maximum while idle.
    Array<u64, MAX_CPU_COUNT> running_virtual_time { Array<u64, MAX_CPU_COUNT>::from_repeated_value(NumericLimits<u64>::max()) };
    // Lowest virtual time among runnable threads when a thread was last
    // queued. Never decreases.
    u64 min_virtual_time { 0 };
};

static Singleton<RecursiveSpinlockProtected<ThreadReadyQueue, LockRank::None>> g_ready_queue;

static RecursiveSpinlockProtected<TotalTimeScheduled, LockRank::None> g_total_time_scheduled {};

static void dump_thread_list(bool = false);

Thread& Scheduler::pull_next_runnable_thread(bool allow_current)
{
    auto affinity_mask = 1u << Processor::current_id();
    auto* current = Thread::current();
    if (!allow_current || current->is_idle_thread() || current->state() != Thread::State::Running || current->should_be_stopped())
        current = nullptr;

    return g_ready_queue->with([&](auto& ready_queue) -> Thread& {
        // Run the candidate with the lowest virtual time. Include the running
        // thread so it can receive adjacent turns. On a tie, prefer the higher
        // priority, then queue order.
        Thread* selected = nullptr;
        auto consider = [&](Thread& thread) {
            if (!selected || thread.m_virtual_time < selected->m_virtual_time
                || (thread.m_virtual_time == selected->m_virtual_time && thread.priority() > selected->priority()))
                selected = &thread;
        };
        for (auto& thread : ready_queue.thread_list) {
            VERIFY(thread.m_is_in_ready_queue);
            if (thread.is_active())
                continue;
            if (!(thread.affinity() & affinity_mask))
                continue;
            consider(thread);
        }
        if (current)
            consider(*current);

        if (selected) {
            ready_queue.running_virtual_time[Processor::current_id()] = selected->m_virtual_time;
            if (selected != current) {
                selected->m_is_in_ready_queue = false;
                ready_queue.thread_list.remove(*selected);
                // A thread may still be active on another CPU when queued.
                selected->set_active(true);
            }
            return *selected;
        }

        ready_queue.running_virtual_time[Processor::current_id()] = NumericLimits<u64>::max();
        auto* idle_thread = Processor::idle_thread();
        idle_thread->set_active(true);
        return *idle_thread;
    });
}

Thread* Scheduler::peek_next_runnable_thread()
{
    auto affinity_mask = 1u << Processor::current_id();

    return g_ready_queue->with([&](auto& ready_queue) -> Thread* {
        for (auto& thread : ready_queue.thread_list) {
            VERIFY(thread.m_is_in_ready_queue);
            if (thread.is_active())
                continue;
            if (!(thread.affinity() & affinity_mask))
                continue;
            return &thread;
        }

        // Unlike in pull_next_runnable_thread() we don't want to fall back to
        // the idle thread. We just want to see if we have any other thread ready
        // to be scheduled.
        return nullptr;
    });
}

bool Scheduler::dequeue_runnable_thread(Thread& thread, bool check_affinity)
{
    if (thread.is_idle_thread())
        return true;

    return g_ready_queue->with([&](auto& ready_queue) {
        if (!thread.m_is_in_ready_queue) {
            VERIFY(!thread.m_ready_queue_node.is_in_list());
            return false;
        }

        if (check_affinity && !(thread.affinity() & (1 << Processor::current_id())))
            return false;

        thread.m_is_in_ready_queue = false;
        ready_queue.thread_list.remove(thread);
        return true;
    });
}

void Scheduler::enqueue_runnable_thread(Thread& thread)
{
    VERIFY(g_scheduler_lock.is_locked_by_current_processor());
    if (thread.is_idle_thread())
        return;
    g_ready_queue->with([&](auto& ready_queue) {
        VERIFY(!thread.m_is_in_ready_queue);
        VERIFY(!thread.m_ready_queue_node.is_in_list());
        // A thread that slept must not bank CPU time: bring it up to the
        // lowest virtual time among runnable threads, queued or running on
        // any CPU. A thread that stayed runnable is never below that.
        u64 lowest = NumericLimits<u64>::max();
        for (auto& queued_thread : ready_queue.thread_list)
            lowest = min(lowest, queued_thread.m_virtual_time);
        for (auto running_virtual_time : ready_queue.running_virtual_time)
            lowest = min(lowest, running_virtual_time);
        if (lowest != NumericLimits<u64>::max())
            ready_queue.min_virtual_time = max(ready_queue.min_virtual_time, lowest);
        thread.m_virtual_time = max(thread.m_virtual_time, ready_queue.min_virtual_time);
        thread.m_is_in_ready_queue = true;
        ready_queue.thread_list.append(thread);
    });
}

UNMAP_AFTER_INIT void Scheduler::start()
{
    VERIFY_INTERRUPTS_DISABLED();

    // We need to acquire our scheduler lock, which will be released
    // by the idle thread once control transferred there
    g_scheduler_lock.lock();

    auto& processor = Processor::current();
    VERIFY(processor.is_initialized());
    auto& idle_thread = *Processor::idle_thread();
    VERIFY(processor.current_thread() == &idle_thread);
    idle_thread.set_ticks_left(1);
    idle_thread.did_schedule();
    idle_thread.set_initialized(true);
    processor.init_context(idle_thread, false);
    idle_thread.set_state(Thread::State::Running);
    VERIFY(idle_thread.affinity() == (1u << processor.id()));
    processor.initialize_context_switching(idle_thread);
    VERIFY_NOT_REACHED();
}

ScheduleResult Scheduler::pick_next(bool allow_current)
{
    VERIFY_INTERRUPTS_DISABLED();

    // Set the in_scheduler flag before acquiring the spinlock. This
    // prevents a recursive call into Scheduler::invoke_async upon
    // leaving the scheduler lock.
    ScopedCritical critical;
    Processor::set_current_in_scheduler(true);
    ScopeGuard guard(
        []() {
            // We may be on a different processor after we got switched
            // back to this thread!
            VERIFY(Processor::current_in_scheduler());
            Processor::set_current_in_scheduler(false);
        });

    SpinlockLocker lock(g_scheduler_lock);

    if constexpr (SCHEDULER_RUNNABLE_DEBUG) {
        dump_thread_list();
    }

    auto& thread_to_schedule = pull_next_runnable_thread(allow_current);
    if constexpr (SCHEDULER_DEBUG) {
        dbgln("Scheduler[{}]: Switch to {} @ {:p}",
            Processor::current_id(),
            thread_to_schedule,
            thread_to_schedule.regs().ip());
    }

    // We need to leave our first critical section before switching context,
    // but since we're still holding the scheduler lock we're still in a critical section
    critical.leave();

    auto* previous_thread = Thread::current();

    thread_to_schedule.set_ticks_left(1);
    auto should_yield = context_switch(&thread_to_schedule);

    if (should_yield == ShouldYield::Yes) {
        return ScheduleResult::YieldAgain;
    }

    if (previous_thread == &thread_to_schedule) {
        return thread_to_schedule.is_idle_thread() ? ScheduleResult::NoRunnableThreadFound : ScheduleResult::Success;
    }

    return ScheduleResult::Success;
}

ScheduleResult Scheduler::yield()
{
    InterruptDisabler disabler;

    auto const* current_thread = Thread::current();
    dbgln_if(SCHEDULER_DEBUG, "Scheduler[{}]: yielding thread {} in_irq={}", Processor::current_id(), *current_thread, Processor::current_in_irq());
    VERIFY(current_thread != nullptr);
    if (Processor::current_in_irq() || Processor::in_critical()) {
        // If we're handling an IRQ we can't switch context, or we're in
        // a critical section where we don't want to switch contexts, then
        // delay until exiting the trap or critical section
        Processor::current().invoke_scheduler_async();
        return ScheduleResult::Delayed;
    }

    ScheduleResult result { ScheduleResult::NoRunnableThreadFound };

    do {
        result = pick_next(false);
    } while (result == ScheduleResult::YieldAgain);

    return result;
}

ShouldYield Scheduler::context_switch(Thread* thread)
{
    VERIFY(g_scheduler_lock.is_locked_by_current_processor());
    thread->did_schedule();

    auto* from_thread = Thread::current();
    VERIFY(from_thread);

    if (from_thread == thread)
        return ShouldYield::No;

    // If the last process hasn't blocked (still marked as running),
    // mark it as runnable for the next round, unless it's supposed
    // to be stopped, in which case just mark it as such.
    if (from_thread->state() == Thread::State::Running) {
        if (from_thread->should_be_stopped())
            from_thread->set_state(Thread::State::Stopped);
        else
            from_thread->set_state(Thread::State::Runnable);
    }

#ifdef LOG_EVERY_CONTEXT_SWITCH
    auto const msg = "Scheduler[{}]: {} -> {} [prio={}] {:p}";

    dbgln(msg,
        Processor::current_id(), from_thread->tid().value(),
        thread->tid().value(), thread->priority(), thread->regs().ip());
#endif

    auto& proc = Processor::current();
    if (!thread->is_initialized()) {
        proc.init_context(*thread, false);
        thread->set_initialized(true);
    }
    thread->set_state(Thread::State::Running);

    PerformanceManager::add_context_switch_perf_event(*from_thread, *thread);

    proc.switch_context(from_thread, thread);

    // NOTE: from_thread at this point reflects the thread we were
    // switched from, and thread reflects Thread::current()
    enter_current(*from_thread);
    VERIFY(thread == Thread::current());

    if (!thread->should_die()) {
        SpinlockLocker lock(thread->get_lock());
        if (thread->dispatch_one_pending_signal() == DispatchSignalResult::Yield)
            return ShouldYield::Yes;
    }

    return ShouldYield::No;
}

void Scheduler::enter_current(Thread& prev_thread)
{
    VERIFY(g_scheduler_lock.is_locked_by_current_processor());

    // We already recorded the scheduled time when entering the trap, so this merely accounts for the kernel time since then
    auto scheduler_time = TimeManagement::scheduler_current_time();
    prev_thread.update_time_scheduled(scheduler_time, true, true);
    auto* current_thread = Thread::current();
    current_thread->update_time_scheduled(scheduler_time, true, false);

    // NOTE: When doing an exec(), we will context switch from and to the same thread!
    //       In that case, we must not mark the previous thread as inactive.
    if (&prev_thread != current_thread)
        prev_thread.set_active(false);

    if (prev_thread.state() == Thread::State::Dying) {
        // If the thread we switched from is marked as dying, then notify
        // the finalizer. Note that as soon as we leave the scheduler lock
        // the finalizer may free from_thread!
        notify_finalizer();
    }
}

void Scheduler::leave_on_first_switch(InterruptsState previous_interrupts_state)
{
    // This is called when a thread is switched into for the first time.
    // At this point, enter_current has already be called, but because
    // Scheduler::context_switch is not in the call stack we need to
    // clean up and release locks manually here
    g_scheduler_lock.unlock(previous_interrupts_state);

    VERIFY(Processor::current_in_scheduler());
    Processor::set_current_in_scheduler(false);
}

void Scheduler::prepare_after_exec()
{
    // This is called after exec() when doing a context "switch" into
    // the new process. This is called from Processor::assume_context
    VERIFY(g_scheduler_lock.is_locked_by_current_processor());

    VERIFY(!Processor::current_in_scheduler());
    Processor::set_current_in_scheduler(true);
}

void Scheduler::prepare_for_idle_loop()
{
    // This is called when the CPU finished setting up the idle loop
    // and is about to run it. We need to acquire the scheduler lock
    VERIFY(!g_scheduler_lock.is_locked_by_current_processor());
    g_scheduler_lock.lock();

    VERIFY(!Processor::current_in_scheduler());
    Processor::set_current_in_scheduler(true);
}

Process* Scheduler::colonel()
{
    VERIFY(s_colonel_process);
    return s_colonel_process;
}

UNMAP_AFTER_INIT void Scheduler::initialize()
{
    VERIFY(Processor::is_initialized()); // sanity check
    VERIFY(TimeManagement::is_initialized());

    g_finalizer_wait_queue = new WaitQueue;

    g_finalizer_has_work.with([](auto& has_work) {
        has_work = false;
    });
    auto [colonel_process, idle_thread] = MUST(Process::create_kernel_process("colonel"sv, idle_loop, nullptr, 1, Process::RegisterProcess::No));
    s_colonel_process = &colonel_process.leak_ref();
    idle_thread->set_priority(THREAD_PRIORITY_MIN);
    idle_thread->set_name("Idle Task #0"sv);

    set_idle_thread(idle_thread);
}

UNMAP_AFTER_INIT void Scheduler::set_idle_thread(Thread* idle_thread)
{
    idle_thread->set_idle_thread();
    Processor::current().set_idle_thread(*idle_thread);
    Processor::set_current_thread(*idle_thread);
}

UNMAP_AFTER_INIT Thread* Scheduler::create_ap_idle_thread(u32 cpu)
{
    VERIFY(cpu != 0);
    // This function is called on the bsp, but creates an idle thread for another AP
    VERIFY(Processor::is_bootstrap_processor());

    VERIFY(s_colonel_process);
    Thread* idle_thread = MUST(s_colonel_process->create_kernel_thread(idle_loop, nullptr, THREAD_PRIORITY_MIN, MUST(KString::formatted("idle thread #{}", cpu))->view(), 1 << cpu, false));
    VERIFY(idle_thread);
    return idle_thread;
}

void Scheduler::add_time_scheduled(u64 time_to_add, bool is_kernel)
{
    g_total_time_scheduled.with([&](auto& total_time_scheduled) {
        total_time_scheduled.total += time_to_add;
        if (is_kernel)
            total_time_scheduled.total_kernel += time_to_add;
    });
}

void Scheduler::timer_tick()
{
    VERIFY_INTERRUPTS_DISABLED();
    VERIFY(Processor::current_in_irq());

    auto* current_thread = Processor::current_thread();
    if (!current_thread)
        return;

    // Sanity checks
    VERIFY(current_thread->current_trap());

    if (current_thread->process().is_kernel_process()) {
        // Because the previous mode when entering/exiting kernel threads never changes
        // we never update the time scheduled. So we need to update it manually on the
        // timer interrupt
        current_thread->update_time_scheduled(TimeManagement::scheduler_current_time(), true, false);
    }

    if (current_thread->previous_mode() == ExecutionMode::User && current_thread->should_die() && !current_thread->is_blocked()) {
        SpinlockLocker scheduler_lock(g_scheduler_lock);
        dbgln_if(SCHEDULER_DEBUG, "Scheduler[{}]: Terminating user mode thread {}", Processor::current_id(), *current_thread);
        current_thread->set_state(Thread::State::Dying);
        Processor::current().invoke_scheduler_async();
        return;
    }

    if (!current_thread->is_idle_thread()) {
        g_ready_queue->with([&](auto& ready_queue) {
            current_thread->m_virtual_time += virtual_time_per_tick(*current_thread);
            ready_queue.running_virtual_time[Processor::current_id()] = current_thread->m_virtual_time;
        });
    }

    if (current_thread->tick())
        return;

    if (!current_thread->is_idle_thread() && !peek_next_runnable_thread()) {
        // If no other thread is ready to be scheduled we don't need to
        // switch to the idle thread. Just give the current thread another
        // time slice and let it run!
        current_thread->set_ticks_left(1);
        current_thread->did_schedule();
        dbgln_if(SCHEDULER_DEBUG, "Scheduler[{}]: No other threads ready, give {} another timeslice", Processor::current_id(), *current_thread);
        return;
    }

    VERIFY_INTERRUPTS_DISABLED();
    VERIFY(Processor::current_in_irq());
    Processor::current().invoke_scheduler_async();
}

void Scheduler::invoke_async()
{
    VERIFY_INTERRUPTS_DISABLED();
    VERIFY(!Processor::current_in_irq());

    // Since this function is called when leaving critical sections (such
    // as a Spinlock), we need to check if we're not already doing this
    // to prevent recursion
    if (!Processor::current_in_scheduler()) {
        ScheduleResult result { ScheduleResult::NoRunnableThreadFound };
        do {
            result = pick_next(true);
        } while (result == ScheduleResult::YieldAgain);
    }
}

void Scheduler::notify_finalizer()
{
    g_finalizer_has_work.with([](auto& has_work) { has_work = true; });
    g_finalizer_wait_queue->notify_all();
}

void Scheduler::idle_loop(void*)
{
    auto& proc = Processor::current();
    dbgln("Scheduler[{}]: idle loop running", proc.id());

    // Interrupts have to be disabled during the idle loop to prevent lost wakeups.
    // If interrupts were enabled between yield() and proc.idle(), we could get an interrupt between those two function calls,
    // but still go to sleep, even if the interrupt caused a thread to be runnable or notified us of one.
    InterruptDisabler disabler;

    for (;;) {
        // First, check if there is a runnable thread we can switch to.
        auto result = yield();

        if (result == ScheduleResult::NoRunnableThreadFound) {
            // If there is no runnable thread, go to sleep until we get an interrupt.

            // This function causes the processor to go to sleep while interrupts are still disabled.
            // After going to sleep, it will listen for interrupts, and if it receives one, it will wake up again.
            // Subsequently, the interrupt handler for the received interrupt will be called.
            proc.idle();

            // This interrupt might have caused a new thread to become runnable or notified us of one.
            // So check for runnable threads in the next loop iteration again.
        }
    }
}

void Scheduler::dump_scheduler_state(bool with_stack_traces)
{
    dump_thread_list(with_stack_traces);
}

bool Scheduler::is_initialized()
{
    // The scheduler is initialized iff the idle thread exists
    return Processor::idle_thread() != nullptr;
}

TotalTimeScheduled Scheduler::get_total_time_scheduled()
{
    return g_total_time_scheduled.with([&](auto& total_time_scheduled) { return total_time_scheduled; });
}

void dump_thread_list(bool with_stack_traces)
{
    dbgln("Scheduler thread list for processor {}:", Processor::current_id());

    auto get_pc = [](Thread& thread) -> FlatPtr {
        if (!thread.current_trap())
            return thread.regs().ip();
        return thread.get_register_dump_from_stack().ip();
    };

    Thread::for_each_ignoring_process_lists([&](Thread& thread) {
        auto color = thread.process().is_kernel_process() ? "\x1b[34;1m"sv : "\x1b[33;1m"sv;
        switch (thread.state()) {
        case Thread::State::Dying:
            dmesgln("  {}{:30}\x1b[0m @ {:08x} is {:14} (Finalizable: {}, nsched: {})",
                color,
                thread,
                get_pc(thread),
                thread.state_string(),
                thread.is_finalizable(),
                thread.times_scheduled());
            break;
        default:
            dmesgln("  {}{:30}\x1b[0m @ {:08x} is {:14} (Pr:{:2}, nsched: {})",
                color,
                thread,
                get_pc(thread),
                thread.state_string(),
                thread.priority(),
                thread.times_scheduled());
            break;
        }
        if (thread.state() == Thread::State::Blocked && thread.blocking_mutex()) {
            dmesgln("    Blocking on Mutex {:#x} ({})", thread.blocking_mutex(), thread.blocking_mutex()->name());
        }
        if (thread.state() == Thread::State::Blocked && thread.blocker()) {
            dmesgln("    Blocking on Blocker {:#x}", thread.blocker());
        }
#if LOCK_DEBUG
        thread.for_each_held_lock([](auto const& entry) {
            dmesgln("    Holding lock {:#x} ({}) at {}", entry.lock, entry.lock->name(), entry.lock_location);
        });
#endif
        if (with_stack_traces) {
            thread.print_backtrace();
        }
        return IterationDecision::Continue;
    });
}

}
