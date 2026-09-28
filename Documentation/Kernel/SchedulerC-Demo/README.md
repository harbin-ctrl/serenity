# Scheduler C - A Proposed Replacement for SerenityOS's Scheduler

This directory contains an educational, standalone browser demo of the
Original Scheduler and the proposed Scheduler C. It does not install or
enable Scheduler C in SerenityOS. The implementation described here is pinned
to the source revisions below; a future kernel patch should be checked against
the model before the two are presented together.

Open **index.html** in a modern browser. The demo uses an editorial paper layout, larger readable type, and distinct task colors. It is self-contained and offline:
no server, package installation, or network access is needed. Send the HTML
file by itself to share the demo. A desktop-sized window makes the comparison
easier to see; narrow screens stack the two schedulers. Diagrams keep
their readable size on small screens: swipe each board sideways to see its CPU.

The opening explains the Original Scheduler and hypothetical repairs A.1
(bucket arithmetic), A.2 (including the current runner), and A.3 (periodic
service rotating through all occupied buckets), then introduces Scheduler C. These
repairs illustrate policy choices; they are not additional runnable models.

## Editing the wording yourself

Open this folder in an editor. Edit these files:

- `index.template.html`: title, introductory copy, explanatory sections, and
  footnotes. Change words between HTML tags; keep the tags and attributes.
- `model.js`: experiment names, descriptions, and scheduler explanations near
  the top of the file.
- `app.js`: takeaway paragraphs near the top of the file and short interface
  labels farther down.
- `README.md`: the accompanying written guide.

Search across the folder to find wording. In JavaScript files,
the copy is inside quoted strings; use a typographic apostrophe (`’`) or
escape a straight apostrophe (`\'`) inside a single-quoted string. After
editing, run `python3 build.py` in this directory to rebuild `index.html`, then
reload that file in your browser. You can share the rebuilt `index.html` by
itself.

## Five experiments

1. **The broken priority dial:** The Original Scheduler gives priorities 2–99 the same bucket.
   Run until the share bars settle; edit a priority and run again.
2. **The priority-1 trap:** Send an input, then Run. The Original Scheduler can starve the desktop
   and Cleanup forever while the two priority-30 workers keep bucket 0 busy.
   Put one worker to sleep. The Original Scheduler now gives lower-bucket tasks turns, because
   it selects a queued task *before* its previous runner rejoins the queue.
3. **A click in a busy desktop:** Automatic input wakes a priority-50 desktop,
   representing WindowServer's configured high priority.
   Each panel reports whether the latest click is waiting or completed, and
   how long it has waited or how long the response took. The Send a click
   buttons deliver the same request to both models. The priorities and
   workload are experiment parameters; they do not assert the actual
   WindowServer configuration.
4. **Too many MAX workers:** A continuously busy priority-30 desktop competes
   with three MAX workers. Scheduler C allocates it about 4.5% of a CPU. The repeat
   stream demands 1.25% (one 1 ms tick every 80 ms), below that allocation.
   Inputs can still wait between desktop turns. Turn off repeating input
   and send isolated requests to inspect individual delays.
   This is an intentionally artificial stress case; WindowServer is configured
   at priority 50, and three continuously busy MAX workers are not its normal workload.
5. **A spinlock stops the clock:** Hold interrupts, send a click, and step.
   Both CPUs continue their current thread; input and timer scheduling wait.
   The 24 ms hold is synthetic kernel work, not a measured lock duration.

**Time to Wait** appears in both scheduler columns directly below **Desktop Input Response**
in every experiment. It updates as the simulation runs. Use **Load mixed workload** in
**Runnable threads** to compare the four requested SerenityOS priority levels:
one busy LOW (10) background worker, four busy NORMAL (30) workers, a brief
HIGH (50) desktop input task, and a brief MAX (99) audio enqueuer. The desktop
wakes for input every 80 ms; the audio enqueuer wakes every 48 ms. Both take one
1 ms tick, then sleep. This workload is available without
adding another experiment tab.

The exact names in [SerenityOS's `sched.h`](https://github.com/SerenityOS/serenity/blob/5a4c0d7bd3f5bce844ec45795d90625659a8edf8/Kernel/API/POSIX/sched.h#L19-L23)
are `THREAD_PRIORITY_LOW` = 10, `THREAD_PRIORITY_NORMAL` = 30,
`THREAD_PRIORITY_HIGH` = 50, and `THREAD_PRIORITY_MAX` = 99.
`THREAD_PRIORITY_MIN` = 1 also exists; it is the range endpoint, rather than
one of these four named workload levels.

The priorities reflect the pinned source: [WindowServer](https://github.com/SerenityOS/serenity/blob/5a4c0d7bd3f5bce844ec45795d90625659a8edf8/Base/etc/SystemServer.ini#L13-L16)
and [AudioServer](https://github.com/SerenityOS/serenity/blob/5a4c0d7bd3f5bce844ec45795d90625659a8edf8/Base/etc/SystemServerUser.ini#L69-L72)
are started with `Priority=high`, which [SystemServer maps to 50](https://github.com/SerenityOS/serenity/blob/5a4c0d7bd3f5bce844ec45795d90625659a8edf8/Userland/Services/SystemServer/Service.cpp#L296-L302). Separately,
[LibAudio sets its background audio enqueuer thread](https://github.com/SerenityOS/serenity/blob/5a4c0d7bd3f5bce844ec45795d90625659a8edf8/Userland/Libraries/LibAudio/ConnectionToServer.cpp#L67-L72)
to `THREAD_PRIORITY_MAX` (99).
The model's brief work durations and periods are illustrative, not measured
behavior of those services.

**Space** runs/pauses, **Right arrow** advances 1 ms, **I** sends input,
**R** restarts. Keyboard shortcuts do not override focused form controls.
Sending a manual click turns off **Repeat every 80 ms**, so that the next
automatic request cannot look like a second click. Check the box again to
resume the periodic stream.

Priorities and added workers restart the experiment; Sleep/Wake changes the
live workload. Restart keeps your edited cast; selecting a preset restores
its original cast. Animation speed changes presentation only, not tick size.

## Footnote on the Original Scheduler’s priority mapping

The prominent amber **[1] WHY?** markers beside “priorities 2–99” link to an
always-visible explanation at the bottom. It includes the exact original C++
expression, the integer-division derivation, worked examples, and pinned
repository paths and line numbers. The priority-constant headers cited there
are included as `sources/A-sched.h` and `sources/A-serenity.h`. The explanation
is embedded in the HTML, so it remains available when that file is shared alone.

## Not Just a Bugfix!

This section explains why Scheduler C changes priority and fairness policy as well
as addressing defects. It includes the two-MAX-worker counterexample, the
normal thread’s roughly 6.6% weighted share, pinned source locations, and the
limits of comparing the unmodified Original Scheduler with Scheduler C. A repaired Original Scheduler is discussed there but is not
an additional runnable scheduler in the demo.

## Is this really just Linux's EEVDF?

This section states the decision-rule difference: EEVDF uses lag eligibility
and virtual deadlines; Scheduler C uses minimum virtual time. The CFS
subquestion states their shared core and the machinery Scheduler C leaves out.
Its 90% desktop-benefit claim is a design estimate awaiting input and audio
measurements, not a benchmark result.

## Correct source identities

| Name | Algorithm | Pinned revision |
| --- | --- | --- |
| Original Scheduler | Original priority buckets and FIFO selection | `5a4c0d7bd3f5bce844ec45795d90625659a8edf8` |
| B (not simulated here) | Smooth weighted credits with recentering | `59a7e4e9d82163f654a843fd65b4300a51f291b9` |
| Scheduler C | Minimum virtual time; charge only the running thread | `c73aafe1d6a31f6b203b92304bd7e2a63dada2ac` |
| Scheduler C used in this demo | Scheduler C plus running-thread wakeup-floor correction | `e125986328558985179e24b5950f6121fc81ffc0` |

Pinned Scheduler.cpp and Thread.cpp snapshots are in `sources/`, retaining
their original copyright and license notices. `sources/SHA256SUMS` identifies
the included snapshots. The demo runs the Original Scheduler and Scheduler C
models; it does not run Scheduler B or measure a live kernel.

## What the model reproduces

### Original Scheduler

- The exact integer bucket expression reduces to
  `floor((100 - priority) / 99) * 31` for valid priorities 1–99.
- Priority 1 maps to bucket 31. Every priority 2–99 maps to bucket 0.
- Select the first queued thread in the lowest numbered occupied bucket.
- The running thread is not a candidate; it is requeued after selection.
- A non-idle turn lasts up to two ticks; a brief job can block after one.
  With no other ready thread, the current thread keeps running and gets a
  fresh turn.
- A wakeup on a busy CPU does not force an immediate selection.

### Scheduler C

- The exact 99-entry source weight table is in `model.js`.
- Each delivered timer tick charges the runner
  `floor((1 << 24) / weight(priority))`: 16,384 at priority 1;
  7,212 at priority 30; 1,024 at priority 99.
- Select the smallest virtual time among ready threads and current.
  Ties favor higher priority, then queue order, with current considered last.
- One tick per turn; the current thread can win adjacent turns.
- Each enqueue computes the minimum of queued virtual times and the running
  snapshot, advances the nondecreasing floor, and clamps the enqueued thread
  upward to that floor. Existing debt is retained.
- The selected runner's snapshot is installed before the old runner is
  requeued. This ordering matters to the floor.
- Running snapshots advance even while a runner is alone, reproducing the
  e1259863 fix. A late waker does not start at a stale zero clock.
- The drawing uses relative virtual time: it subtracts the smallest active
  clock. The dashed line follows that moving minimum. Numbers in the
  decision text and tooltips are absolute virtual time.

### Boundaries and simplifications

- Single CPU, all ready threads eligible; no SMP/affinity or stopped threads.
- 1,000 Hz proposed: one tick is 1 ms in both panels (Original: 2 ms turns; Scheduler C: 1 ms turns). These are simulated milliseconds.
- Ordinary non-GUI workers are permanently CPU-bound unless put to sleep
  manually. The audio enqueuer in the mixed workload wakes periodically, runs for one
  tick, and then sleeps; missed releases are not accumulated as extra jobs.
- GUI tasks consume one *complete* tick per input; the sleeping desktop blocks
  at the boundary after its queue empties. The overload desktop remains busy.
- Tick-boundary arrivals are delivered before timer selection, matching the
  relevant TimerQueue::fire-before-Scheduler::timer_tick ordering. A newly
  arrived event cannot be completed using the interval that just elapsed.
- Manual inputs occur at the current simulated boundary. There is no modeled
  immediate priority preemption of a busy CPU on wakeup.
- The IRQ hold freezes selection and timer charging while wall time advances.
  Input arrivals are retained in order. One pending tick is charged at unlock,
  illustrating timer coalescing; exact hardware behavior is not asserted.
  Its CPU time is attributed to the interrupted task as injected kernel work.
- Sleep/Wake controls are external workload interventions. They do not model
  the syscall cost or time needed for a particular running program to block.
- No scheduling overhead, driver/IPC work, compositor, display refresh,
  real userland behavior, voluntary yield scenario, or measured spinlock cost.
- CPU share is elapsed task CPU time divided by total elapsed simulation time;
  idle time can make shares sum to less than 100%. Worst response is retained
  for the whole run. History shows the latest 96 ticks. Response records retain
  the latest 2,048 completions, while the worst latency remains cumulative.
- Positive weights imply progress in these fixed finite workloads. They are
  not a proof of a real-system worst-case response bound.
- **Time to Wait** records the time from becoming runnable to the start of
  each CPU turn. Sleeping time and CPU service time are excluded. A consecutive
  turn with no intervening wait contributes 0 ms. The chart averages completed
  waits across tasks at the same priority and uses one shared scale for both
  schedulers. It appears in both panels for every workload. A waiting thread with
  no completed turn shows **No turn yet** and its current wait separately. These values are simulated dispatch
  delays, not measured audio or GUI deadlines.

## Historical numerical observations (250 Hz, before the timer change)

The following results belong to the previous 4 ms tick model, not the current 1,000 Hz demo. At 10,000 ticks (40 seconds simulated), without manual interventions:

| Experiment | Original Scheduler | Scheduler C |
| --- | --- | --- |
| Workers p99 / p30 / p10, desktop asleep | 33.34% / 33.34% / 33.32% | 81.78% / 11.62% / 6.60% |
| p1 Cleanup with two busy p30 workers | 0% | 18.04% |
| Input preset, last response after periodic input | 32 ms | 4 ms |
| Busy p30 desktop with three p99 workers | 25.00% | 4.52% |
| One p1 worker against one p99 worker | 50.00% / 50.00% | 5.89% / 94.11% |
| Mixed workload, average runnable wait p99 / p50 / p30 / p10 | 36.80 / 37.33 / 38.12 / 38.15 ms | 0.00 / 1.34 / 17.08 / 33.11 ms |

These observations come from this teaching model, not measurements of
SerenityOS, QEMU, actual WindowServer latency, or a full kernel emulation.
In particular, B's earlier reported longest gaps are not imported into Scheduler C.

## Editing / rebuilding

Readable sources:

- `model.js`: scheduling, events, and scenario definitions; also usable with
  Node via `require('./model.js')` for model exploration.
- `app.js`: browser controls and SVG animation.
- `style.css`: layout and visual styling.
- `index.template.html`: document structure and explanatory text.
- `build.py`: inserts the sources into the standalone HTML.

Run `python3 build.py` after edits. No dependencies are needed to build.
`index.html` is the distributable result. The source snapshots are evidence,
not code compiled or executed by the demonstration.

## Timer decision and presentation update

The proposal now uses 1,000 Hz (1 ms ticks), applied to both demo panels for comparison. GUI and audio bursts remain one tick, now 1 ms; their periods remain unchanged. Increasing the frequency improves accounting resolution and scheduling opportunities, with more interrupt/scheduler overhead. This demo change does not modify the QEMU kernel or the pinned source snapshots. Model notes are short, always-visible paragraphs instead of a foldout.
