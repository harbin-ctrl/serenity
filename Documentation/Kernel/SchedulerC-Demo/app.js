/* UI for the standalone scheduler teaching model. No network or libraries. */
(() => {
  'use strict';
  const {Model,scenarios,task,bucket,weight,charge,TICK}=SchedulerLab;
  const $=id=>document.getElementById(id);
  const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const priorityNote='<a class="footnote-ref" href="#priority-bucket-note" role="doc-noteref" aria-label="Footnote 1: why priorities 2–99 share a bucket">[1] WHY?</a>';
  const annotatePriority=s=>esc(s).replace(/priorities 2(?:–| through )99/i,match=>`${match} ${priorityNote}`);
  let scenario=scenarios[0], definitions=scenario.tasks.map(t=>({...t}));
  let models=[], playing=false, modified=false, requestId=0, accumulator=0, lastFrame=0, nextAuto=24;
  const takeaways={
    trap:['Starvation is different from a small share.', 'With two busy workers in bucket 0, the Original Scheduler can give priority-1 work no CPU time at all. Put one of those workers to sleep: it selects before requeueing its previous runner, so the low bucket can now get a turn. Scheduler C gives every continuously runnable thread progress in this fixed workload.'],
    input:['Watch the delay, not just the average share.', 'Each panel reports whether the latest click is still waiting or has completed, with its elapsed time. A click must first reach the desktop task and then get CPU service. Here Scheduler C’s short turns and service-clock placement help a sleeping high-priority desktop compete with busy workers.'],
    overload:['A meaningful priority is also a resource claim.', 'Scheduler C gives each MAX thread roughly seven times a normal thread’s share. Three MAX workers leave this continuously runnable desktop about 4.5%. That policy is working as configured, but it is not a latency guarantee. At 1,000 Hz, each modeled click needs 1 ms of CPU every 80 ms: 1.25%, below that allocation. Clicks can still wait between the desktop’s turns. Restricting MAX use or reserving interactive capacity is a system policy decision. Compare this with the sleeping desktop in experiment 03.'],
    lock:['No scheduler can select its way out of an IRQ-off interval.', 'The striped timeline is injected kernel work with interrupts disabled. Input waits and the current thread keeps the CPU on both sides. Shorter critical sections address this delay; changing the selection algorithm alone cannot. The 24 ms hold is an illustration, not a measured SerenityOS lock duration.'],
    mixed:['Compare SerenityOS’s LOW, NORMAL, HIGH, and MAX priorities.', 'LOW (10) background work and four NORMAL (30) workers remain busy. The HIGH (50) desktop task models WindowServer handling brief input, while a MAX (99) audio enqueuer wakes periodically. Time to Wait measures runnable delay before a turn. These are simulated policy outcomes, not measured audio or GUI deadlines.']
  };
  $('scenarios').innerHTML=scenarios.filter(s=>s.id!=='mixed').map((s,i)=>`<button class="scenario" data-scenario="${s.id}" aria-pressed="false"><span class="number">0${i+1}</span><span>${esc(s.title)}</span></button>`).join('');
  function cpuSvg() {
    return `<rect class="cpu-box" x="449" y="85" width="137" height="132" rx="12"/><text class="svg-label" x="517" y="107" text-anchor="middle">ONE CPU</text><text class="cpu-caption" data-cpu-state x="517" y="128" text-anchor="middle"></text><text class="cpu-name" data-cpu-name x="517" y="164" text-anchor="middle"></text><rect x="464" y="188" width="107" height="4" rx="2" fill="#dce6ec"/><rect class="cpu-progress" x="464" y="188" width="0" height="4" rx="2"/><text class="cpu-caption" data-cpu-turn x="517" y="207" text-anchor="middle"></text><path d="M420 152 H440 m-5 -4 5 4 -5 4" fill="none" stroke="#8099ab" stroke-width="1.4"/><g data-lock style="display:none"><rect class="lock-curtain" x="441" y="70" width="151" height="160" rx="12"/><text x="517" y="117" text-anchor="middle" fill="#81364f" font-size="20">▧</text><text x="517" y="145" text-anchor="middle" fill="#81364f" font-size="12" font-weight="700">INTERRUPTS OFF</text><text data-lock-time x="517" y="168" text-anchor="middle" fill="#81364f" font-size="18"></text><text x="517" y="194" text-anchor="middle" fill="#925168" font-size="10">input + timer wait</text></g>`;
  }
  function machineSvg(m) {
    let drawing='';
    if(m.kind==='A') {
      drawing=`<text class="svg-label" x="16" y="21">HIGHEST NONEMPTY BUCKET WINS</text><rect x="13" y="32" width="407" height="111" rx="8" fill="#f4f7f1" stroke="#bfcdbd"/><text class="svg-muted" x="25" y="50">BUCKET 0 · priorities 2–99</text><a class="svg-footnote-ref" href="#priority-bucket-note" aria-label="Footnote 1: why priorities 2–99 share a bucket" tabindex="0"><title>Footnote 1: exact code and integer arithmetic</title><rect x="190" y="34" width="79" height="23" rx="5"/><text x="229.5" y="50" text-anchor="middle">[1] WHY?</text></a><path d="M37 164 H399" stroke="#a5b8aa" stroke-dasharray="3 4"/><text x="217" y="178" text-anchor="middle" class="svg-muted">Buckets 1–30 receive no valid priority</text><rect x="13" y="194" width="407" height="103" rx="8" fill="#fcf6ef" stroke="#dccbb8"/><text class="svg-muted" x="25" y="213">BUCKET 31 · priority 1</text><text data-bucket-empty x="217" y="252" text-anchor="middle" class="svg-muted">No priority-1 tasks</text>`;
      drawing+=m.tasks.map(t=>`<g class="task-token" data-token="${t.id}"><rect width="95" height="31" rx="6" fill="${t.color}" fill-opacity=".05" stroke="${t.color}" stroke-opacity=".75"/><circle cx="9" cy="15" r="3" fill="${t.color}"/><text x="17" y="14" fill="${t.color}" font-size="9">${esc(t.name)}</text><text x="17" y="25" fill="${t.color}" font-size="7" opacity=".8">priority ${t.priority}</text></g>`).join('');
    } else {
      drawing=`<text class="svg-label" x="16" y="21">LOWEST SERVICE CLOCK WINS</text><line x1="151" y1="36" x2="151" y2="270" stroke="#8ca5b7" stroke-dasharray="3 4"/><text class="svg-muted" x="151" y="289">↑ least served</text><text class="svg-muted" x="400" y="289" text-anchor="end">further ahead →</text>`;
      drawing+=m.tasks.map((t,i)=>`<g data-clock-row="${t.id}"><text x="16" y="${53+i*26}" fill="${t.color}" font-size="10">${esc(t.name)}</text><text x="16" y="${64+i*26}" fill="#5e7283" font-size="7">p${t.priority} · +${charge(t.priority).toLocaleString("en-US")} / tick</text><line x1="151" y1="${50+i*26}" x2="398" y2="${50+i*26}" stroke="#d3e0e8"/><line class="clock-line" data-clock-line="${t.id}" x1="151" y1="${50+i*26}" x2="151" y2="${50+i*26}" stroke="${t.color}" stroke-opacity=".55" stroke-width="3"/><circle class="clock-dot" data-clock-dot="${t.id}" cx="151" cy="${50+i*26}" r="5" fill="${t.color}"/><text data-clock-number="${t.id}" x="402" y="${54+i*26}" fill="#4b6072" font-size="8" text-anchor="end"></text></g>`).join('');
    }
    return `<div class="machine-scroll"><svg class="machine" viewBox="0 0 600 305" role="img" aria-label="${m.kind==='A'?'Priority buckets and CPU':'Virtual service clocks and CPU'}">${drawing}${cpuSvg()}</svg></div>`;
  }
  function panel(m) {
    const k=m.kind, title=k==='A'?'Original Scheduler':'Scheduler C';
    return `<article class="scheduler ${k.toLowerCase()}" id="panel-${k}"><div class="panel-head">${k==='A'?'':`<span class="letter">${k}</span>`}<div><h2>${title}</h2><p>${k==='A'?'Priority buckets · FIFO':'Weighted virtual time · fair shares'}</p></div><span class="turn-badge">${k==='A'?'2 ticks / turn':'1 tick / turn'}</span></div><p class="panel-description" data-description></p>${machineSvg(m)}<div class="decision" data-decision></div><div class="timeline-area"><div class="mini-label"><span>CPU HISTORY</span><span>${TICK} ms / tile · time →</span></div><div class="timeline" data-timeline aria-label="CPU service timeline"></div></div><div class="response-area"><div class="mini-label"><span>DESKTOP INPUT RESPONSE</span><span>Latest click on this scheduler</span></div><div class="response-summary"><div class="response-copy"><span class="response-kicker" data-response-kicker>READY TO COMPARE</span><strong data-response-title>No click sent yet</strong><span class="response-detail" data-response-detail>Send a click to both schedulers and compare their response times.</span></div><button class="response-send" type="button">Send click to both</button></div><div class="response-caption"><span data-response-caption>No completed clicks yet</span><span data-pending>0 queued</span></div><div class="metrics"><div class="metric" data-age><strong>—</strong><span>OLDEST INPUT WAIT</span></div><div class="metric"><strong data-last>—</strong><span>LAST RESPONSE</span></div><div class="metric"><strong data-worst>—</strong><span>WORST RESPONSE</span></div></div></div><section class="wait-panel" aria-label="Time to Wait for ${title}"><div class="wait-heading"><h3>Time to Wait</h3><span data-wait-scale></span></div><p class="wait-explainer">Live average from becoming runnable to each CPU turn, grouped by priority. Sleeping and running time are excluded.</p><div class="wait-panel-rows" data-wait-rows></div><p class="wait-panel-note">Only completed waits enter the average; an unfinished wait appears below its row. Both panels use the same bar scale.</p></section><div class="shares"><div class="mini-label"><span>CPU SHARE SO FAR</span><span>Elapsed CPU time · includes IRQ hold</span></div>${m.tasks.map(t=>`<div class="share-row" style="--task-color:${t.color}" data-share="${t.id}"><span class="task-name"><i class="swatch"></i>${esc(t.name)}</span><div class="share-track"><div class="share-fill"></div></div><span class="share-number">—</span></div>`).join('')}</div></article>`;
  }
  function play(value) {
    playing=value; accumulator=0;
    $('play').textContent=value?'Ⅱ Pause':'▶ Run';
    $('play').setAttribute('aria-pressed',String(value));
  }
  function reset() {
    play(false); requestId=0; nextAuto=24;
    models=['A','C'].map(k=>new Model(k,definitions));
    $('comparison').innerHTML=models.map(panel).join('');
    $('input-status').textContent='Each click goes to both schedulers.';
    $('auto-input').checked=scenario.auto;
    document.querySelectorAll('[data-scenario]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.scenario===scenario.id)));
    $('load-mixed').setAttribute('aria-pressed',String(scenario.id==='mixed'));
    $('scenario-tag').innerHTML=annotatePriority(modified?'CUSTOM WORKLOAD · '+scenario.title:scenario.tag);
    $('scenario-text').textContent=modified?'You have changed the cast. Both schedulers now run your priorities under the same input stream. Use CPU shares and response waits to see what those choices do.':scenario.text;
    const takeaway=$('takeaway');
    takeaway.hidden=scenario.id==='priorities';
    if (!takeaway.hidden) {
      $('takeaway-title').textContent=takeaways[scenario.id][0];
      $('takeaway-text').textContent=takeaways[scenario.id][1]+(modified?' The explanation describes the preset; your edited priorities may change its outcome.':'');
    }
    for(const m of models) {
      const p=$('panel-'+m.kind);
      const svg=p.querySelector('.machine');
      svg.querySelectorAll('.task-token').forEach(node=>svg.append(node));
      svg.append(svg.querySelector('[data-lock]'));
      const description=modified?(m.kind==='A'?'Priorities 2–99 share bucket 0; priority 1 uses bucket 31. Selection happens before the old runner rejoins.':'Lowest virtual time wins. A tick charges 2²⁴ / weight; higher priority advances the clock more slowly.'):scenario[m.kind.toLowerCase()];
      p.querySelector('[data-description]').innerHTML=m.kind==='A'?annotatePriority(description):esc(description);
      p.querySelector('.response-send').addEventListener('click',sendInput);
    }
    renderTasks(); render();
  }
  function renderTasks() {
    $('task-list').innerHTML=definitions.map(t=>`<div class="task-row" style="--task-color:${t.color}"><div class="task-title"><span class="task-name"><i class="swatch"></i>${esc(t.name)}</span><small>${t.role==='gui'?(t.always?'Always busy + input work':'Sleeps between inputs'):t.role==='pulse'?`Brief job · ${TICK} ms every ${t.period} ms`:'CPU-bound worker'}</small></div><label class="priority-control">Priority <input data-priority="${t.id}" type="number" min="1" max="99" step="1" value="${t.priority}" aria-label="${esc(t.name)} priority"></label><div class="task-weight">Original bucket <strong>${bucket(t.priority)}</strong><br>Scheduler C weight <strong>${weight(t.priority).toLocaleString('en-US')}</strong></div>${t.role==='gui'?'<span class="gui-badge">INPUT TASK</span>':t.role==='pulse'?'<span class="gui-badge">BRIEF JOB</span>':`<button data-sleep="${t.id}">Sleep</button>`}</div>`).join('');
    $('add-worker').disabled=definitions.length>=9;
  }
  function inputEvent() {
    requestId++;
    return {id:requestId};
  }
  function sendInput() {
    const repeatWasOn=$('auto-input').checked;
    $('auto-input').checked=false;
    const request=inputEvent();
    models.forEach(m=>m.input(request));
    $('input-status').textContent=`Click #${requestId} sent to both.${repeatWasOn?' Repeating input turned off.':''} ${playing?'Compare the response status below.':'Press Run or Step to deliver CPU service.'}`;
    render();
  }
  function tick(count=1) {
    for(let i=0;i<count;i++) {
      const arrivals=[];
      if($('auto-input').checked && models[0].time+TICK>=nextAuto) {
        arrivals.push(inputEvent()); nextAuto=models[0].time+TICK+80;
      }
      models.forEach(m=>m.advance(arrivals));
    }
    render();
  }
  const fmt=x=>x===null?'—':`${x} ms`;
  const priorityNames={10:'LOW',30:'NORMAL',50:'HIGH',99:'MAX'};
  function renderWaitCharts() {
    const priorities=[...new Set(definitions.map(t=>t.priority))].sort((a,b)=>b-a);
    const rows=priorities.map(priority=>{
      const names=definitions.filter(t=>t.priority===priority).map(t=>t.name).join(', ');
      const values=models.map(m=>{
        const tasks=m.tasks.filter(t=>t.priority===priority);
        const count=tasks.reduce((sum,t)=>sum+t.waitSamples,0);
        const pending=Math.max(0,...tasks.filter(t=>t.state==='ready').map(t=>t.wait));
        return {count,pending,average:count?tasks.reduce((sum,t)=>sum+t.waitTotal,0)/count:null};
      });
      return {priority,names,values};
    });
    const largest=Math.max(4,...rows.flatMap(row=>row.values.map(value=>value.average??0)));
    const scale=Math.ceil(largest/4)*4;
    models.forEach((m,i)=>{
      const panel=$('panel-'+m.kind);
      panel.querySelector('[data-wait-scale]').textContent=`${m.time.toLocaleString('en-US')} ms elapsed · shared scale 0–${scale} ms`;
      panel.querySelector('[data-wait-rows]').innerHTML=rows.map(row=>{
        const value=row.values[i];
        return `<div class="wait-row"><div class="wait-task"><strong>${priorityNames[row.priority]?`${priorityNames[row.priority]} · ${row.priority}`:`Priority ${row.priority}`}</strong><span>${esc(row.names)}</span></div><div class="wait-series"><div class="wait-track"><span class="wait-fill" style="width:${value.average===null?0:Math.max(1,value.average/scale*100)}%"></span></div><strong class="wait-value">${value.average===null?'No turn yet':`${value.average.toFixed(1)} ms`}</strong></div><span class="wait-pending${value.pending?'':' empty'}">${value.pending?`Longest current wait: ${value.pending} ms`:'No task waiting now'}</span></div>`;
      }).join('');
    });
  }
  function render() {
    $('clock').innerHTML=`${models[0].time.toLocaleString('en-US')} <small>ms</small>`;
    document.body.classList.toggle('fast',Number($('speed').value)>4);
    $('hold').disabled=models.some(m=>m.locked||!m.current);
    for(const m of models) {
      const p=$('panel-'+m.kind), q=s=>p.querySelector(s);
      q('[data-decision]').textContent=m.locked?`${m.current.name} holds interrupts off for ${m.lockUntil-m.time} ms more. Input stays pending; no new task can take the CPU.`:m.reason;
      q('.cpu-box').classList.toggle('active',!!m.current);
      q('[data-cpu-state]').textContent=m.current?'RUNNING':'IDLE';
      q('[data-cpu-name]').textContent=m.kind==='C'?(m.current?.name||'No ready work'):(m.current?'':'No ready work');
      q('[data-cpu-name]').setAttribute('fill',m.current?.color||'#53697b');
      q('[data-cpu-turn]').textContent=m.current?`${m.quantum*TICK} ms until next choice`:'waiting for work';
      q('.cpu-progress').setAttribute('width',m.current?107*m.quantum/(m.kind==='A'?2:1):0);
      q('[data-lock]').style.display=m.locked?'':'none';
      q('[data-lock-time]').textContent=`${m.lockUntil-m.time} ms`;
      if(m.kind==='A') {
        const upper=m.ready.filter(t=>bucket(t.priority)===0), lower=m.ready.filter(t=>bucket(t.priority)===31);
        for(const t of m.tasks) {
          const node=q(`[data-token="${t.id}"]`);
          let x=25,y=60;
          if(t===m.current){x=472;y=143;}
          else {const a=bucket(t.priority)===0?upper:lower,index=a.indexOf(t);x=25+(Math.max(0,index)%4)*98;y=(bucket(t.priority)===0?61:227)+Math.floor(Math.max(0,index)/4)*37;}
          node.style.transform=`translate(${x}px, ${y}px)`;
          node.style.opacity=t.state==='sleeping'?'0':'1';
        }
        q('[data-bucket-empty]').textContent=lower.length?'':(m.tasks.some(t=>t.priority===1)?'Empty right now':'No priority-1 tasks');
      } else {
        const awake=m.tasks.filter(t=>t.state!=='sleeping');
        const floor=awake.length?Math.min(...awake.map(t=>t.vt)):m.minVT;
        const spread=Math.max(16384,...awake.map(t=>t.vt-floor+charge(t.priority)));
        for(const t of m.tasks) {
          const x=151+Math.max(0,Math.min(1,(t.vt-floor)/spread))*224;
          q(`[data-clock-dot="${t.id}"]`).setAttribute('cx',x);
          q(`[data-clock-dot="${t.id}"]`).setAttribute('r',t===m.current?7:4);
          q(`[data-clock-line="${t.id}"]`).setAttribute('x2',x);
          const label=q(`[data-clock-number="${t.id}"]`);
          label.textContent=t.state==='sleeping'?'asleep':`+${(t.vt-floor).toLocaleString('en-US')}`;
          label.setAttribute('x',Math.max(230,x+44));
          if(x>350) label.setAttribute('x',416);
        }
        if(m.lastClamp && m.time-m.lastClamp.at<=TICK && !m.locked) q('[data-decision]').textContent+=` ${m.lastClamp.name} joined at clock ${m.lastClamp.to.toLocaleString('en-US')}; sleeping did not bank service.`;
      }
      q('[data-timeline]').innerHTML=m.history.map(h=>`<span class="tick ${h.locked?'locked':''}" style="background-color:${m.tasks.find(t=>t.id===h.id)?.color||'#dbe5ec'}" title="${h.at}–${h.at+TICK} ms: ${esc(m.tasks.find(t=>t.id===h.id)?.name||'Idle')}${h.locked?' · interrupts off':''}"></span>`).join('')+'<span class="tick future"></span>'.repeat(96-m.history.length);
      const latest=m.responses.at(-1);
      const completed=latest?.id===requestId;
      const outstanding=m.gui?.jobs.find(job=>job.id===requestId)||m.deferred.find(job=>job.id===requestId);
      const status=q('.response-summary');
      status.classList.toggle('complete',!!completed);
      status.classList.toggle('waiting',requestId>0&&!completed);
      q('[data-response-kicker]').textContent=requestId?`CLICK #${requestId} · ${completed?'COMPLETED':'WAITING'}`:'READY TO COMPARE';
      q('[data-response-title]').textContent=requestId?(completed?`Responded in ${latest.latency} ms`:`Waiting ${m.time-(outstanding?.at??m.time)} ms`):'No click sent yet';
      q('[data-response-detail]').textContent=requestId?(completed?`Completed at ${latest.at} ms simulated time.`:(m.deferred.some(job=>job.id===requestId)?'Input delivery is deferred while interrupts are off.':'The desktop has not completed this click yet.')):'Send a click to both schedulers and compare their response times.';
      q('[data-response-caption]').textContent=latest?`Last completed: click #${latest.id}`:'No completed clicks yet';
      const pending=(m.gui?.jobs.length||0)+m.deferred.length;
      q('[data-pending]').textContent=`${pending} queued${m.deferred.length?' · IRQ deferred':''}`;
      const age=m.pendingAge(),last=m.responses.at(-1)?.latency??null;
      q('[data-age] strong').textContent=fmt(age);
      q('[data-age]').classList.toggle('alert',age!==null&&age>=40);
      q('[data-last]').textContent=fmt(last);
      q('[data-worst]').textContent=fmt(m.worstLatency);
      for(const t of m.tasks) {
        const row=q(`[data-share="${t.id}"]`),percent=m.time?t.cpu/m.time*100:0;
        row.querySelector('.share-fill').style.width=`${percent}%`;
        const number=row.querySelector('.share-number');
        number.textContent=m.time?`${percent.toFixed(1)}%`:'—';
        number.classList.toggle('never',t.cpu===0&&m.time>=80&&t.state==='ready');
        row.title=`${t.cpu} ms CPU · ${t.state} · longest ready wait ${t.maxWait} ms${m.kind==='C'?` · virtual time ${t.vt} · +${charge(t.priority)} per tick`:''}`;
      }
    }
    document.querySelectorAll('[data-sleep]').forEach(b=>{
      b.disabled=models.some(m=>m.locked);
      b.textContent=models[0].tasks.find(t=>t.id===+b.dataset.sleep).state==='sleeping'?'Wake':'Sleep';
    });
    renderWaitCharts();
  }
  $('scenarios').addEventListener('click',e=>{const b=e.target.closest('[data-scenario]');if(!b)return;scenario=scenarios.find(s=>s.id===b.dataset.scenario);definitions=scenario.tasks.map(t=>({...t}));modified=false;reset();});
  $('load-mixed').onclick=()=>{scenario=scenarios.find(s=>s.id==='mixed');definitions=scenario.tasks.map(t=>({...t}));modified=false;reset();};
  $('play').onclick=()=>play(!playing);
  $('step').onclick=()=>{play(false);tick();};
  $('restart').onclick=reset;
  $('click').onclick=()=>sendInput();
  $('hold').onclick=()=>{models.forEach(m=>m.hold());$('input-status').textContent='24 ms IRQ hold injected. Send a click, then Run or Step.';render();};
  $('auto-input').onchange=()=>{nextAuto=models[0].time+TICK;};
  $('speed').onchange=()=>{accumulator=0;render();};
  $('task-list').addEventListener('change',e=>{
    if(!e.target.matches('[data-priority]'))return;
    const t=definitions.find(t=>t.id===+e.target.dataset.priority),value=Number(e.target.value);
    if(!Number.isInteger(value)||value<1||value>99){e.target.value=t.priority;return;}
    t.priority=value;modified=true;reset();
  });
  $('task-list').addEventListener('click',e=>{const b=e.target.closest('[data-sleep]');if(!b)return;models.forEach(m=>m.toggleSleep(+b.dataset.sleep));render();});
  $('add-worker').onclick=()=>{if(definitions.length>=9)return;const id=definitions.length;definitions.push(task(id,`Worker ${id}`,30));modified=true;reset();};
  document.addEventListener('keydown',e=>{
    if(e.target.closest('input,select,textarea,button,summary,[role=button]')||e.ctrlKey||e.altKey||e.metaKey)return;
    if(e.code==='Space'){e.preventDefault();play(!playing);}
    if(e.code==='ArrowRight'){e.preventDefault();play(false);tick();}
    if(e.code==='KeyI')sendInput();
    if(e.code==='KeyR')reset();
  });
  document.addEventListener('visibilitychange',()=>{if(document.hidden)play(false);});
  function frame(now) {
    const delta=lastFrame?Math.min(now-lastFrame,250):0;lastFrame=now;
    if(playing){accumulator+=delta;const interval=1000/Number($('speed').value);const count=Math.floor(accumulator/interval);if(count){accumulator-=count*interval;tick(count);}}
    requestAnimationFrame(frame);
  }
  window.schedulerDemo={get models(){return models;},get playing(){return playing;},tick,sendInput,reset};
  reset();requestAnimationFrame(frame);
})();
