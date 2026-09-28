/* Single-CPU teaching model of pinned SerenityOS scheduler sources.
 * Original Scheduler (internal key A): 5a4c0d7bd3f5bce844ec45795d90625659a8edf8
 * C: e125986328558985179e24b5950f6121fc81ffc0
 * See README.md for tick-boundary and synthetic spinlock assumptions.
 */
(function (root) {
  'use strict';
  const TICK = 1; // Proposal: 1,000 Hz timer; both panels use the same clock.
  const WEIGHTS = [
    1024,1053,1084,1115,1147,1180,1213,1248,1284,1321,1359,1398,1438,1479,1522,1565,1610,1656,1704,1753,1803,1855,1908,1963,2019,2077,2137,2198,2261,2326,2393,2461,2532,2605,2680,2756,2836,2917,3001,3087,3175,3266,3360,3457,3556,3658,3763,3871,3982,4096,4214,4334,4459,4587,4718,4854,4993,5136,5284,5435,5591,5752,5917,6087,6261,6441,6626,6816,7012,7213,7420,7633,7852,8077,8309,8547,8792,9045,9304,9571,9846,10128,10419,10718,11026,11342,11667,12002,12347,12701,13065,13440,13826,14223,14631,15051,15483,15927,16384
  ];
  const bucket = p => Math.trunc((100 - p) / 99) * 31;
  const weight = p => WEIGHTS[p - 1];
  const charge = p => Math.trunc(2 ** 24 / weight(p));
  const colors = ['#08737a','#a65313','#7653a8','#b13c73','#4a701d','#3e66ad','#866418','#ab4133','#2e6e84'];
  function task(id, name, priority, role = 'worker', always = true) {
    return {id, name, priority, role, always, color: colors[id]};
  }
  const scenarios = [
    {id:'priorities', title:'The broken priority dial', tag:'Original Scheduler ignores priorities 2–99',
      text:'The urgent worker asks for priority 99. The background worker asks for 10. Watch their CPU shares: the Original Scheduler treats them alike. Scheduler C makes the dial matter.',
      a:'Integer division puts priorities 2 through 99 in bucket 0. They take the same 2 ms turns.',
      c:'The lowest service clock runs. Higher priority advances that clock more slowly, earning more turns.',
      tasks:[task(0,'Desktop',50,'gui',false),task(1,'Urgent work',99),task(2,'Build',30),task(3,'Background',10)], auto:false},
    {id:'trap', title:'The priority-1 trap', tag:'Original Scheduler can starve a task completely',
      text:'This artificial starvation case puts Cleanup and the desktop at priority 1. Two busy workers keep the Original Scheduler’s bucket 0 occupied. Send a click: the Original Scheduler can leave it waiting forever. Scheduler C still gives them turns.',
      a:'Two workers are essential here: while one runs, the other remains in bucket 0. Bucket 31 never wins.',
      c:'Even priority 1 has a positive share. Its clock jumps farther per turn, but it eventually becomes the lowest again.',
      tasks:[task(0,'Desktop',1,'gui',false),task(1,'Worker A',30),task(2,'Worker B',30),task(3,'Cleanup',1)], auto:false},
    {id:'input', title:'A click in a busy desktop', tag:'Watch the input response',
      text:'The desktop task represents WindowServer at its configured priority 50. It sleeps until input arrives, then needs one 1 ms turn to respond. Send a click and compare the waiting and completed times below each scheduler.',
      a:'The Original Scheduler wakes the desktop into the same FIFO bucket as the workers. Priority 50 cannot move it to the front.',
      c:'A waking task joins near the lowest runnable clock. At equal clocks, higher priority wins the tie.',
      tasks:[task(0,'Desktop',50,'gui',false),task(1,'Compile A',30),task(2,'Compile B',30),task(3,'Compile C',30),task(4,'Compile D',30)], auto:true},
    {id:'overload', title:'Too many MAX workers', tag:'Scheduler C has a tradeoff, too',
      text:'This artificial overload case makes the desktop continuously busy at priority 30 against three priority-99 workers. Scheduler C honors their weights, leaving the desktop about 4.5% of CPU. Fair shares alone do not guarantee prompt interaction.',
      a:'The priority bug accidentally gives the desktop an equal share here. Each of the four threads gets about 25%.',
      c:'MAX means about seven times normal’s weight per thread. Three MAX workers together dominate the CPU budget.',
      tasks:[task(0,'Desktop',30,'gui',true),task(1,'MAX worker A',99),task(2,'MAX worker B',99),task(3,'MAX worker C',99)], auto:true},
    {id:'lock', title:'A spinlock stops the clock', tag:'A limitation shared by both schedulers',
      text:'Press “Hold interrupts”, then send a click. The current thread keeps the CPU for 21 ms of injected kernel work. Input delivery and timer scheduling wait until it releases the lock.',
      a:'Neither priority nor the normal 2 ms turn can interrupt an IRQ-disabled critical section.',
      c:'Virtual-time selection can act only when scheduling is allowed. Scheduler C also has to wait for the lock to end.',
      tasks:[task(0,'Desktop',50,'gui',false),task(1,'Worker A',30),task(2,'Worker B',30)], auto:false},
    {id:'mixed', title:'Time to Wait', tag:'MIXED DESKTOP WORKLOAD · BRIEF HIGH-PRIORITY TASKS',
      text:'Four NORMAL workers and one LOW background worker stay busy. The HIGH desktop task wakes for periodic input, and a MAX audio enqueuer wakes for brief work. Compare the live wait at LOW, NORMAL, HIGH, and MAX.',
      a:'The Original Scheduler puts LOW (10), NORMAL (30), HIGH (50), and MAX (99) in the same FIFO bucket. Short high-priority jobs wait behind ordinary work.',
      c:'HIGH desktop and MAX audio jobs gain service sooner through smaller virtual-time charges and priority tie-breaks. They sleep again after one tick.',
      tasks:[task(0,'Desktop',50,'gui',false),task(1,'Build',30),task(2,'Browser',30),task(3,'Indexer',30),task(4,'Compiler',30),
        {...task(5,'Audio enqueuer',99,'pulse',false),period:48,firstWake:8},task(6,'Background scan',10)], auto:true}
  ];

  class Model {
    constructor(kind, definitions) {
      if (!['A','C'].includes(kind)) throw Error('Unknown scheduler');
      this.kind = kind;
      this.tasks = definitions.map(d => ({...d, vt:0, cpu:0, wait:0, maxWait:0, waitTotal:0, waitSamples:0, nextWake:d.firstWake, state:'sleeping', jobs:[], turns:0}));
      this.ready=[]; this.current=null; this.runningVT=Infinity; this.minVT=0;
      this.time=0; this.quantum=0; this.history=[]; this.responses=[]; this.switches=0;
      this.worstLatency=null;
      this.lockUntil=0; this.deferred=[];
      this.reason='Ready to begin.'; this.lastChoice=0; this.lastClamp=null;
      for (const t of this.tasks) if (t.always) this.enqueue(t);
      this.pick(false);
    }
    enqueue(t) {
      if (this.ready.includes(t)) throw Error('Duplicate ready entry');
      if (this.kind==='C') {
        const lowest=Math.min(this.runningVT, ...this.ready.map(q=>q.vt));
        if (Number.isFinite(lowest)) this.minVT=Math.max(this.minVT,lowest);
        const before=t.vt;
        t.vt=Math.max(t.vt,this.minVT);
        if (t.vt>before) this.lastClamp={name:t.name,from:before,to:t.vt,at:this.time};
      }
      t.state='ready'; t.wait=0; this.ready.push(t);
    }
    pick(allowCurrent=true) {
      const prev=this.current;
      let selected=null;
      if (this.kind==='A') {
        for (const t of this.ready) if (!selected || bucket(t.priority)<bucket(selected.priority)) selected=t;
      } else {
        const candidates=[...this.ready];
        if (allowCurrent && prev && prev.state==='running') candidates.push(prev);
        for (const t of candidates) if (!selected || t.vt<selected.vt || (t.vt===selected.vt && t.priority>selected.priority)) selected=t;
        this.runningVT=selected ? selected.vt : Infinity;
      }
      if (selected!==prev) {
        if (selected) this.ready.splice(this.ready.indexOf(selected),1);
        if (prev && prev.state==='running') this.enqueue(prev);
        if (prev || selected) this.switches++;
      }
      this.current=selected;
      this.quantum=this.kind==='A' ? 2 : 1;
      if (selected) {
        selected.waitTotal+=selected===prev?0:selected.wait;
        selected.waitSamples++;
        selected.state='running'; selected.wait=0; selected.turns++;
        this.reason=this.kind==='A'
          ? `${selected.name} taken from bucket ${bucket(selected.priority)}. The old runner rejoins after selection.`
          : `${selected.name} has the lowest eligible clock (${selected.vt.toLocaleString('en-US')}). Ties prefer higher priority, then queue order.`;
      } else this.reason='No runnable task. The CPU is idle.';
      this.lastChoice=this.time;
    }
    get gui() { return this.tasks.find(t=>t.role==='gui'); }
    get locked() { return this.time<this.lockUntil; }
    input(event) {
      if (!this.gui) return;
      const request={...event, at:event.at ?? this.time};
      if (this.locked) this.deferred.push(request);
      else this.deliver(request);
    }
    deliver(request) {
      this.gui.jobs.push(request);
      if (this.gui.state==='sleeping') this.enqueue(this.gui);
      if (!this.current) this.pick(false); // waking an idle single CPU
    }
    hold(ms=24) {
      if (!this.current || this.locked) return false;
      this.lockUntil=this.time+ms;
      this.reason=`${this.current.name} holds interrupts off. Timer preemption and input delivery are deferred.`;
      return true;
    }
    toggleSleep(id) {
      const t=this.tasks.find(t=>t.id===id);
      if (!t || t.role==='gui' || t.role==='pulse' || this.locked) return;
      if (t.state==='sleeping') {
        this.enqueue(t);
        if (!this.current) this.pick(false);
      } else {
        if (this.ready.includes(t)) this.ready.splice(this.ready.indexOf(t),1);
        t.state='sleeping'; t.wait=0;
        if (t===this.current) { this.current=null; this.pick(false); }
      }
    }
    advance(arrivals=[]) {
      const runner=this.current, start=this.time, wasLocked=this.locked;
      const servicedJob=runner?.role==='gui' && !wasLocked ? runner.jobs[0] : null;
      for (const t of this.ready) { t.wait+=TICK; t.maxWait=Math.max(t.maxWait,t.wait); }
      if (runner) runner.cpu+=TICK;
      this.time+=TICK;
      this.history.push({at:start,id:runner?.id ?? null,locked:wasLocked});
      if (this.history.length>96) this.history.shift();
      // Events at the end of the interval are delivered before timer selection,
      // like TimerQueue::fire() preceding Scheduler::timer_tick().
      for (const request of arrivals) {
        if (wasLocked) this.deferred.push({...request,at:this.time});
        else this.input({...request,at:this.time});
      }
      if (!wasLocked) for (const t of this.tasks) {
        if (t.role==='pulse' && this.time>=t.nextWake) {
          if (t.state==='sleeping') this.enqueue(t);
          t.nextWake+=t.period;
        }
      }
      if (wasLocked && this.locked) return this;
      if (wasLocked) {
        for (const request of this.deferred.splice(0)) this.deliver(request);
        for (const t of this.tasks) if (t.role==='pulse' && this.time>=t.nextWake) {
          if (t.state==='sleeping') this.enqueue(t);
          while (t.nextWake<=this.time) t.nextWake+=t.period;
        }
        // Stylized IRQ coalescing: deliver one pending timer tick at unlock.
      }
      if (runner && this.kind==='C') {
        runner.vt+=charge(runner.priority);
        this.runningVT=runner.vt;
      }
      if (servicedJob && runner.jobs[0]===servicedJob) {
        const job=runner.jobs.shift();
        this.responses.push({id:job.id,latency:this.time-job.at,at:this.time});
        this.worstLatency=Math.max(this.worstLatency??0,this.time-job.at);
        if (this.responses.length>2048) this.responses.shift();
      }
      if (runner && ((runner.role==='gui' && !runner.always && !runner.jobs.length) || (runner.role==='pulse' && !wasLocked))) {
        runner.state='sleeping'; runner.wait=0; this.current=null; this.pick(false);
      } else if (this.current && runner) {
        this.quantum--;
        if (this.quantum<=0) {
          if (this.ready.length) this.pick(true);
          else {
            this.quantum=this.kind==='A'?2:1; this.current.turns++;
            this.current.waitSamples++;
            this.reason=`${this.current.name} is alone, so it keeps running.`;
          }
        } else this.reason=`${this.current.name} continues the second 1 ms half of its 2 ms turn.`;
      } else if (this.ready.length) this.pick(false);
      return this;
    }
    pendingAge() {
      const jobs=[...(this.gui?.jobs||[]),...this.deferred];
      return jobs.length ? this.time-Math.min(...jobs.map(j=>j.at)) : null;
    }
    check() {
      const readyIds=this.ready.map(t=>t.id);
      if (new Set(readyIds).size!==readyIds.length) throw Error('Duplicate ready task');
      for (const t of this.tasks) {
        if ((t.state==='ready')!==this.ready.includes(t)) throw Error('Ready state mismatch');
        if ((t.state==='running')!==(t===this.current)) throw Error('Running state mismatch');
        if (t.vt<0 || !Number.isInteger(t.vt)) throw Error('Invalid virtual time');
      }
      return true;
    }
  }
  const api={TICK,WEIGHTS,bucket,weight,charge,colors,task,scenarios,Model};
  if (typeof module!=='undefined' && module.exports) module.exports=api;
  else root.SchedulerLab=api;
})(typeof globalThis!=='undefined'?globalThis:this);
