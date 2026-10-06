(() => {
const STATUSES = ["Not Started","In Progress","On Hold","Complete","Cancelled"];
const SCLS = {"Urgent":"st-ug","Not Started":"st-ns","In Progress":"st-ip","On Hold":"st-oh","Complete":"st-ok","Cancelled":"st-cx"};
const SVAR = {"Urgent":"--s-ug","Not Started":"--s-ns","In Progress":"--s-ip","On Hold":"--s-oh","Complete":"--s-ok","Cancelled":"--s-cx"};
// Projects, team, types and priorities come from the Settings tab (seeded from SEED_SETTINGS in data.js).
let SETTINGS, PROJECTS = [], TEAM = [], TYPES = [], PRIS = [];
// Project modules are milestones: {name, status} with status Upcoming / In Progress / Complete.
const MSTAT = ["Upcoming","In Progress","Complete"];
const MVAR = {"Upcoming":"--s-ns","In Progress":"--s-ip","Complete":"--s-ok"};
function normModule(m){
  if (typeof m === "string") return {name:m, status:"Upcoming", value:{}};
  m = m || {};
  return {name:m.name||"", status: MSTAT.includes(m.status) ? m.status : "Upcoming",
    value: m.value && typeof m.value === "object" ? {...m.value} : {}};
}
function normSettings(s){
  s = s || {};
  return {
    projects: (s.projects||[]).map((p,i) => ({id:p.id||"p"+i, name:p.name||"", code:p.code||"", start:p.start||"",
      duration: p.duration === "" || p.duration == null ? "" : Number(p.duration), actualEnd:p.actualEnd||"", modules:(p.modules||[]).map(normModule)})),
    priorities: [...(s.priorities||[])], types: [...(s.types||[])],
    valueRate: s.valueRate === "" || s.valueRate == null ? "" : Number(s.valueRate),
    team: (s.team||[]).map((m,i) => ({id:m.id||"m"+i, name:m.name||""}))
  };
}
function applySettings(s){
  SETTINGS = normSettings(s);
  PROJECTS = SETTINGS.projects.filter(p=>p.name).map(p => ({...p, key:p.name, code:p.code || p.name.slice(0,2).toUpperCase()}));
  TEAM = SETTINGS.team.map(m=>m.name).filter(Boolean);
  TYPES = SETTINGS.types.filter(Boolean);
  PRIS = SETTINGS.priorities.filter(Boolean);
}
applySettings(window.SEED_SETTINGS);

const $ = s => document.querySelector(s);
const el = (tag, attrs={}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k,v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v; else if (k === "style") n.style.cssText = v;
    else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
    else if (k === "text") n.textContent = v; else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
};
const store = {
  get(k){ try { return localStorage.getItem(k); } catch { return null; } },
  set(k,v){ try { localStorage.setItem(k,v); } catch {} }
};

// ---------- dates ----------
const pad = n => String(n).padStart(2,"0");
const iso = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
const TODAY = iso(new Date());
const parse = s => { if (!s) return null; const [y,m,d] = s.split("-").map(Number); return new Date(y, m-1, d); };
const DAY = 86400000;
const diffDays = (a,b) => Math.round((parse(a) - parse(b)) / DAY);
const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const fmtY = s => { const d = parse(s); return d ? `${pad(d.getDate())} ${MON[d.getMonth()]} ${d.getFullYear()}` : "—"; };
const fmt = fmtY;
$("#asof").textContent = "Today " + fmtY(TODAY);

// ---------- state ----------
let tasks = [];
let loaded = false, dbRef = null, canManage = false, canWrite = true;
let view = "overview";
const TASK_VIEWS = ["overview","board","timeline","list"];
const VIEWS = [...TASK_VIEWS, "value", "settings"];
if (VIEWS.includes(location.hash.slice(1))) view = location.hash.slice(1);
else { const v = store.get("pm.view"); if (VIEWS.includes(v)) view = v; }
const me = ""; // no "I am" picker: whoever can edit the tracker updates any task
const editor = "";    // no sign-in: changes are recorded as "Manager"
// Sort for the Tasks table. Task numbers run in the order tasks were added, so "latest" = highest number.
const SORTS = {latest:["order",-1], oldest:["order",1], priority:["priority",1], due:["due",1], status:["status",1]};
let [sortKey, sortDir] = SORTS[store.get("pm.sort")] || SORTS.latest;
let openId = null;

function projCode(p){ return (PROJECTS.find(x=>x.key===p)||{code:"?"}).code; }
function closed(t){ return t.status === "Complete" || t.status === "Cancelled"; }
// Urgent isn't a status: every open High-priority task goes in the board's Urgent column.
function isUrgent(t){ return !closed(t) && t.priority === "High"; }
function isOverdue(t){ return t.status === "In Progress" && t.due && t.due < TODAY; }
function lateFinish(t){ return t.status === "Complete" && t.due && t.end && t.end > t.due; }
function daysLate(t){ return isOverdue(t) ? diffDays(TODAY, t.due) : 0; }
function serial(t){
  const same = tasks.filter(x => x.project === t.project).sort((a,b)=>(a.order||0)-(b.order||0));
  return `${projCode(t.project)}1.${same.indexOf(t)+1}`;
}
function people(){ return TEAM; }
function estEnd(p){
  if (!p.start || !p.duration) return "";
  const d = parse(p.start); d.setDate(d.getDate() + Number(p.duration)); return iso(d);
}
function mine(t){ return me && (t.assignees||[]).includes(me); }
function canEditStatus(t){ return canWrite && (canManage || mine(t)); }

// Board month/year filter: a task matches if its dates (start → done/due) touch that month or year.
// Each task belongs to exactly one year, so the years always add up to "All years":
// completed → year it was done, cancelled → year cancelled, otherwise start/due year; undated backlog → this year.
function taskYear(t){
  const d = t.status === "Complete" ? (t.end || t.start || t.due)
    : t.status === "Cancelled" ? (t.cancelled || t.end || t.start || t.due)
    : (t.start || t.due || t.end);
  return (d || (t.createdAt||"").slice(0,10) || TODAY).slice(0,4);
}
function inPeriod(t){
  const y = $("#fYear").value, m = view === "board" ? $("#fMonth").value : "";
  if (!y && !m) return true;
  if (!m) return taskYear(t) === y;
  const a = t.start || t.due || t.end, b = t.end || t.cancelled || t.due || t.start;
  if (!a) return false;
  const lo = y ? `${y}-${m||"01"}` : null, hi = y ? `${y}-${m||"12"}` : null;
  if (y) return a.slice(0,7) <= hi && b.slice(0,7) >= lo;
  // Month without a year: any year.
  for (let yy = +a.slice(0,4); yy <= +b.slice(0,4); yy++){ const k = `${yy}-${m}`; if (a.slice(0,7) <= k && b.slice(0,7) >= k) return true; }
  return false;
}
function filtered(opts={}){
  // Status/priority menus only exist on Tasks and Timeline; month/year only where shown.
  const stPr = view === "list" || view === "timeline", period = ["board","overview","value"].includes(view);
  const p = $("#fProject").value, who = $("#fPerson").value, st = stPr ? $("#fStatus").value : "", pr = stPr ? $("#fPri").value : "";
  const q = $("#fSearch").value.trim().toLowerCase(), open = $("#fOpen").checked;
  return tasks.filter(t =>
    (!p || t.project === p) && (!who || (t.assignees||[]).includes(who)) && (!pr || t.priority === pr) &&
    (opts.ignoreStatus || !st || (st === "Overdue" ? isOverdue(t) : t.status === st)) &&
    (!open || !closed(t)) && (!period || inPeriod(t)) &&
    (!q || [t.name,t.project,t.type,(t.assignees||[]).join(" "),t.notes].join(" ").toLowerCase().includes(q)));
}

// ---------- filters setup ----------
function fillSelect(sel, items, keep){
  const cur = sel.value; const first = sel.options[0];
  sel.replaceChildren(first, ...items.map(i => el("option",{value:i.value ?? i, text:i.label ?? i})));
  if (keep !== false) sel.value = cur;
}
function refreshPickers(){
  fillSelect($("#fProject"), PROJECTS.map(p=>({value:p.key,label:`${p.key} (${p.code})`})));
  fillSelect($("#fPerson"), people());
  fillSelect($("#fStatus"), [...STATUSES, "Overdue"]);
  fillSelect($("#fPri"), PRIS);
  const years = new Set([TODAY.slice(0,4)]);
  tasks.forEach(t => years.add(taskYear(t)));
  fillSelect($("#fYear"), [...years].sort());
  if ($("#fMonth").options.length < 2) fillSelect($("#fMonth"), MON.map((m,i) => ({value:pad(i+1), label:m})));
}
["#fProject","#fPerson","#fStatus","#fPri","#fMonth","#fYear","#fOpen"].forEach(s => $(s).addEventListener("change", render));
$("#fSearch").addEventListener("input", render);
$("#fSort").addEventListener("change", e => { [sortKey, sortDir] = SORTS[e.target.value]; store.set("pm.sort", e.target.value); render(); });
function paintSort(){
  const k = Object.keys(SORTS).find(k => SORTS[k][0] === sortKey && SORTS[k][1] === sortDir);
  $("#fSort").value = k || "";
}

document.querySelectorAll("nav.tabs button").forEach(b => b.addEventListener("click", () => setView(b.dataset.view)));
function setView(v){
  view = v; store.set("pm.view", v);
  document.querySelectorAll("nav.tabs button").forEach(b => b.setAttribute("aria-selected", b.dataset.view === v));
  VIEWS.forEach(x => $("#v-"+x).hidden = x !== v);
  $("#filters").hidden = v === "settings";
  document.body.dataset.view = v;
  $("#fSort").hidden = v !== "list";
  $("#fStatus").hidden = $("#fPri").hidden = !(v === "list" || v === "timeline");
  $("#fMonth").hidden = v !== "board";
  $("#fYear").hidden = !["board","overview"].includes(v);
  $("#fPerson").hidden = $("#fOpen").closest("label").hidden = v === "value";
  render();
}

// ---------- render ----------
function render(){
  $("#addBtn").hidden = !(canManage && canWrite) || view !== "list";
  const b = $("#banner"); b.replaceChildren();
  if (loaded && !canWrite) b.append(el("div",{class:"banner"}, "You can view this tracker. Ask the owner for Contributor access to update tasks."));
  if (view === "settings"){
    // Don't rebuild the form under someone mid-edit; internal changes call renderSettings() directly.
    if (!sDirty || !$("#v-settings").childElementCount) renderSettings();
    return;
  }
  if (!loaded || !tasks.length){
    const msg = !loaded ? ["Loading tasks…","Tasks come from the shared tracker and appear here in a moment."]
      : ["No tasks yet", canManage ? "Use “+ New task” to add the first one." : "Tasks will appear here once the owner adds them."];
    [...TASK_VIEWS, "value"].forEach(x => $("#v-"+x).replaceChildren(el("div",{class:"empty"}, el("b",{text:msg[0]}), msg[1])));
    return;
  }
  if (view === "value"){
    // Keep the cursor in the same box when a saved value re-renders the table.
    const a = document.activeElement, id = a && a.closest && a.closest("#v-value") ? a.id : null;
    renderValue();
    const back = id && document.getElementById(id); if (back){ back.focus(); back.select && back.select(); }
    return;
  }
  ({overview:renderOverview, board:renderBoard, timeline:renderTimeline, list:renderList})[view]();
}

function statusPill(t){
  if (isOverdue(t)) return el("span",{class:"pill st-late", text:"Overdue"});
  return el("span",{class:"pill "+SCLS[t.status], text:t.status});
}

function renderOverview(){
  const list = filtered({ignoreStatus:true});
  const done = list.filter(t=>t.status==="Complete");
  const ip = list.filter(t=>t.status==="In Progress");
  const od = list.filter(isOverdue);
  const ns = list.filter(t=>t.status==="Not Started");
  const active = list.filter(t=>t.status!=="Cancelled");
  const onTime = done.filter(t=>t.due && t.end);
  const onTimePct = onTime.length ? Math.round(100*onTime.filter(t=>t.end<=t.due).length/onTime.length) : null;
  const durs = done.filter(t=>t.start&&t.end).map(t=>diffDays(t.end,t.start)+1);
  const avg = durs.length ? (durs.reduce((a,b)=>a+b,0)/durs.length).toFixed(1) : "—";
  const pct = active.length ? Math.round(100*done.length/active.length) : 0;

  const kpi = (label, value, sub, cls, onclick) => el("div",{class:"kpi "+(cls||""), style: onclick?"cursor:pointer":"", onclick},
    el("div",{class:"eyebrow",text:label}), el("b",{text:value}), el("span",{class:"sub",text:sub}));
  const jump = st => () => { $("#fStatus").value = st; setView("list"); };

  const kpis = el("div",{class:"kpis"},
    kpi("Completed", `${pct}%`, `${done.length} of ${active.length} tasks`, "", jump("Complete")),
    kpi("In progress", ip.length, "being built now", "", jump("In Progress")),
    kpi("Overdue", od.length, "past due, not complete", od.length?"alert":"", jump("Overdue")),
    kpi("Not started", ns.length, "in the backlog", "", jump("Not Started")),
    kpi("Finished on time", onTimePct==null?"—":onTimePct+"%", `avg ${avg} days per task`));

  // value delivered (from the Value analysis page)
  const valuePanel = el("div",{class:"panel"},
    el("div",{class:"phead"}, el("h2",{text:"Value delivered"}),
      el("button",{class:"btn addrow", style:"margin:0", onclick:()=>setView("value")}, "Open value analysis →")),
    valueTiles(moduleRows()), topValue(moduleRows()));

  const milestones = milestoneChart();

  // status charts
  const charts = el("div",{class:"charts"}, statusDonut(list), statusByProject(list), completionColumns(list));

  // monthly completions — every completed task in the selection lands in exactly one bar
  const yr = $("#fYear").value, nowM = TODAY.slice(0,7);
  const ends = done.map(t => t.end).filter(Boolean).map(d => d.slice(0,7)).sort();
  let m0 = yr ? `${yr}-01` : (ends[0] || nowM), m1 = yr ? (yr === TODAY.slice(0,4) ? nowM : `${yr}-12`) : (ends.length && ends[ends.length-1] > nowM ? ends[ends.length-1] : nowM);
  if (yr && yr > TODAY.slice(0,4)) m1 = `${yr}-12`;
  const months = [];
  for (let d = parse(m0+"-01"); iso(d).slice(0,7) <= m1; d.setMonth(d.getMonth()+1)) months.push(iso(d).slice(0,7));
  const mc = months.map(m => done.filter(t=>t.end && t.end.startsWith(m)).length);
  const noEnd = done.filter(t => !t.end).length;
  const bars = months.map((m,i) => ({label: MON[Number(m.slice(5))-1] + (months.length > 12 || (!yr && m.endsWith("-01")) ? " " + m.slice(2,4) : ""), n: mc[i], now: m === nowM}));
  if (noEnd) bars.push({label:"No date", n:noEnd, none:true});
  const mx = Math.max(1, ...bars.map(b=>b.n));
  const monthPanel = el("div",{class:"panel"},
    el("div",{class:"phead"}, el("h2",{text:"Tasks completed per month"}), el("span",{class:"note", text:`${done.length} completed${yr ? " in "+yr : ""}`})),
    el("div",{class:"months"}, ...bars.map(b => el("div",{class:"m"+(b.now?" now":"")+(b.none?" none":""), "data-tip":`${b.label}: ${b.n} completed`},
      el("i",{style:`height:${Math.max(2, 100*b.n/mx * 0.82)}%`}, el("span",{text:b.n})),
      el("small",{text:b.label})))));

  // attention
  const attnItems = [...od].sort((a,b)=>daysLate(b)-daysLate(a));
  const soon = list.filter(t=>!closed(t) && t.due && t.due>=TODAY && diffDays(t.due,TODAY)<=7).sort((a,b)=>a.due<b.due?-1:1);
  const undated = list.filter(t=>t.status==="In Progress" && !t.due);
  const attn = el("ul",{class:"attn"});
  const addAttn = (t, tag, cls) => attn.append(el("li",{onclick:()=>openSheet(t.id), tabindex:"0", onkeydown:e=>{if(e.key==="Enter")openSheet(t.id)}},
    el("div",{class:"t"}, el("div",{text:t.name}), el("small",{text:`${serial(t)} · ${(t.assignees||[]).join(", ")||"Unassigned"}`})),
    el("span",{class:cls,text:tag})));
  attnItems.forEach(t => addAttn(t, `${daysLate(t)}d late`, "late-tag"));
  soon.forEach(t => addAttn(t, `due ${fmt(t.due)}`, "code"));
  undated.forEach(t => addAttn(t, "no due date", "code"));
  const attnPanel = el("div",{class:"panel"}, el("h2",{text:"Needs attention"}),
    attn.childElementCount ? attn : el("p",{class:"note",text:"Nothing overdue, due this week, or missing a due date."}));

  // people
  const ppl = el("div",{class:"people"});
  people().forEach(n => {
    const ts = list.filter(t=>(t.assignees||[]).includes(n)); if (!ts.length) return;
    const open = ts.filter(t=>!closed(t)).length, l = ts.filter(isOverdue).length, d = ts.filter(t=>t.status==="Complete").length;
    ppl.append(el("div",{class:"person", tabindex:"0", onclick:()=>{ $("#fPerson").value=n; setView("board"); }},
      el("b",{text:n}), el("div",{class:"counts"}, el("span",{text:`${open} open`}), el("span",{text:`${d} done`}), l?el("span",{class:"l",text:`${l} late`}):null)));
  });
  const pplPanel = el("div",{class:"panel"}, el("h2",{text:"Team workload"}), ppl);

  $("#v-overview").replaceChildren(kpis, valuePanel, milestones, charts,
    el("div",{class:"grid2"}, el("div",{class:"stack"}, monthPanel, pplPanel), el("div",{class:"stack"}, attnPanel)));
}


// ---------- overview charts ----------
// Status colours are the app's status tokens; every chart also carries labels + a legend, so colour is never the only cue.
const CHART_ST = ["Not Started","In Progress","On Hold","Complete","Cancelled"];
const pctOf = (n, d) => d ? Math.round(100*n/d) : 0;
const legend = keys => el("div",{class:"legend"}, ...keys.map(s => el("span",{}, el("i",{style:`background:var(${SVAR[s]})`}), s)));

function statusDonut(list){
  const counts = CHART_ST.map(s => [s, list.filter(t=>t.status===s).length]).filter(([,n]) => n);
  const total = list.length, R = 70, C = 2*Math.PI*R, GAP = counts.length > 1 ? 2 : 0;
  const svg = document.createElementNS("http://www.w3.org/2000/svg","svg");
  svg.setAttribute("viewBox","0 0 180 180"); svg.setAttribute("class","donut"); svg.setAttribute("role","img");
  svg.setAttribute("aria-label", counts.map(([s,n]) => `${s} ${n}`).join(", "));
  let off = 0;
  const ns = (tag, attrs) => { const n = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
  svg.append(ns("circle",{cx:90, cy:90, r:R, fill:"none", stroke:"var(--sunk)", "stroke-width":24}));
  counts.forEach(([s,n]) => {
    const len = C*n/total;
    const c = ns("circle",{cx:90, cy:90, r:R, fill:"none", stroke:`var(${SVAR[s]})`, "stroke-width":24,
      "stroke-dasharray":`${Math.max(0.5,len-GAP)} ${C}`, "stroke-dashoffset":-off, transform:"rotate(-90 90 90)",
      "data-tip":`${s}: ${n} task${n===1?"":"s"} (${pctOf(n,total)}%)`});
    svg.append(c); off += len;
  });
  const t1 = ns("text",{x:90, y:88, "text-anchor":"middle", class:"donut-n"}); t1.textContent = total;
  const t2 = ns("text",{x:90, y:108, "text-anchor":"middle", class:"donut-l"}); t2.textContent = "tasks";
  svg.append(t1, t2);
  return el("div",{class:"panel"}, el("h2",{text:"Portfolio status"}),
    total ? el("div",{class:"donutwrap"}, svg,
      el("ul",{class:"dlegend"}, ...counts.map(([s,n]) => el("li",{"data-tip":`${s}: ${n} of ${total}`},
        el("i",{style:`background:var(${SVAR[s]})`}), el("span",{text:s}), el("b",{class:"num",text:n}), el("small",{class:"num",text:`${pctOf(n,total)}%`})))))
      : el("p",{class:"note",text:"No tasks for this selection."}));
}

function statusByProject(list){
  const rows = PROJECTS.map(p => [p, list.filter(t=>t.project===p.key)]).filter(([,ts]) => ts.length);
  const used = CHART_ST.filter(s => list.some(t=>t.status===s));
  return el("div",{class:"panel"}, el("h2",{text:"Status by project"}),
    rows.length ? el("div",{class:"sbp"}, el("div",{class:"sbp-rows"},
      ...rows.map(([p,ts]) => el("div",{class:"sbp-row"},
        el("div",{class:"sbp-nm", text:p.key}),
        el("div",{class:"sbp-bar", role:"img", "aria-label":`${p.key}: `+used.map(s=>`${s} ${ts.filter(t=>t.status===s).length}`).join(", ")},
          ...used.map(s => { const n = ts.filter(t=>t.status===s).length; if (!n) return null; const w = 100*n/ts.length;
            return el("i",{style:`width:${w}%;background:var(${SVAR[s]})`, "data-tip":`${p.key} · ${s}: ${n} of ${ts.length} (${Math.round(w)}%)`}, w >= 7 ? el("span",{text:n}) : null); })),
        el("div",{class:"sbp-n num", text:ts.length})))),
      el("div",{class:"sbp-axis"}, el("span"), el("div",{}, ...[0,25,50,75,100].map(v => el("span",{style:`left:${v}%`, text:v+"%"}))), el("span")),
      legend(used))
    : el("p",{class:"note",text:"No tasks for this selection."}));
}

// Complete vs incomplete (Not Started + In Progress + On Hold) per project; cancelled tasks are left out.
function completionColumns(list){
  const rows = PROJECTS.map(p => { const ts = list.filter(t=>t.project===p.key), live = ts.filter(t=>t.status!=="Cancelled");
    const d = ts.filter(t=>t.status==="Complete").length, n = live.length;
    const v = pctOf(d, n); return {p, d, n, v, inc: n - d, iv: n ? 100 - v : 0}; }).filter(r => r.n);
  const seg = (cls, h, label, tip) => h ? el("i",{class:cls, style:`height:${h}%`, "data-tip":tip}, h >= 9 ? el("span",{class:"num", text:label}) : null) : null;
  return el("div",{class:"panel"}, el("h2",{text:"% complete by project"}),
    rows.length ? el("div",{class:"ccwrap"}, el("div",{class:"colchart"},
      el("div",{class:"cc-grid"}, ...[100,75,50,25,0].map(v => el("div",{}, el("span",{text:v+"%"})))),
      el("div",{class:"cc-cols"}, ...rows.map(r => el("div",{class:"cc-col", role:"img", "aria-label":`${r.p.key}: ${r.v}% complete, ${r.iv}% incomplete`},
        el("div",{class:"cc-track"}, el("div",{class:"cc-stack"},
          seg("cc-inc", r.iv, r.iv+"%", `${r.p.key} · Incomplete: ${r.inc} of ${r.n} tasks (${r.iv}%)`),
          seg("cc-done", r.v, r.v+"%", `${r.p.key} · Complete: ${r.d} of ${r.n} tasks (${r.v}%)`))),
        el("small",{text:r.p.key}))))),
      el("div",{class:"legend"}, el("span",{}, el("i",{style:"background:var(--s-ok)"}), "Complete"),
        el("span",{"data-tip":"Not Started + In Progress + On Hold"}, el("i",{style:"background:var(--s-ns-bg);box-shadow:inset 0 0 0 1px var(--line)"}), "Incomplete")))
    : el("p",{class:"note",text:"No tasks for this selection."}));
}

// Milestone progress: each project's modules from Settings, in order, coloured by status (with icon + label).
function milestoneChart(){
  const fp = $("#fProject").value;
  const projs = PROJECTS.filter(p => (!fp || p.key === fp) && p.modules.length);
  const head = el("div",{class:"phead"}, el("h2",{text:"Milestone progress"}),
    el("div",{class:"legend", style:"margin:0"}, ...MSTAT.map(s => el("span",{}, el("i",{style:`background:var(${MVAR[s]})`}), s))));
  if (!projs.length) return el("div",{class:"panel"}, head,
    el("p",{class:"note", style:"margin:0"}, "No modules yet. Add them under Settings → Project details, then set each one to Upcoming, In Progress or Complete. ",
      el("button",{class:"btn addrow", style:"margin:0 0 0 6px", onclick:()=>setView("settings")}, "Open Settings")));
  return el("div",{class:"panel milestones"}, head, ...projs.map(p => {
    const c = s => p.modules.filter(m => m.status === s).length, n = p.modules.length, done = c("Complete");
    return el("div",{class:"ms-proj"},
      el("div",{class:"ms-head"},
        el("b",{text:p.key}),
        el("span",{class:"note num", text:`${done} of ${n} complete · ${c("In Progress")} in progress · ${c("Upcoming")} upcoming`}),
        el("div",{class:"ms-pct"}, el("div",{class:"bar"}, el("i",{style:`width:${pctOf(done,n)}%;background:var(--s-ok)`})), el("b",{class:"num", text:pctOf(done,n)+"%"}))),
      el("ol",{class:"msteps"}, ...p.modules.map((m,i) => el("li",{class:"mstep", style:`--sc:var(${MVAR[m.status]})`, "data-s":m.status, "data-tip":`${i+1}. ${m.name} — ${m.status}`},
        el("div",{class:"ms-track"}, el("span",{class:"ms-dot", "aria-hidden":"true", text: m.status==="Complete" ? "✓" : String(i+1)})),
        el("div",{class:"ms-nm", text:m.name}),
        el("small",{text:m.status})))));
  }));
}

// One tooltip for every [data-tip] mark.
(() => {
  const tip = el("div",{class:"tip", role:"tooltip", hidden:true}); document.body.append(tip);
  document.addEventListener("mouseover", e => { const m = e.target.closest && e.target.closest("[data-tip]"); if (!m){ tip.hidden = true; return; }
    tip.textContent = m.getAttribute("data-tip"); tip.hidden = false; });
  document.addEventListener("mousemove", e => { if (!tip.hidden){ tip.style.left = Math.min(e.clientX+14, innerWidth - tip.offsetWidth - 8)+"px"; tip.style.top = (e.clientY+16)+"px"; } });
})();

// ---------- value analysis ----------
// Per module (Settings → Project details): vendor quote vs in-house build cost (cost saving), manual hours per month
// before vs after (time saving), valued at the module's hourly rate or the default rate. Stored on the module as m.value.
const num = x => x === "" || x == null || isNaN(+x) ? null : +x;
const rm = n => n == null ? "—" : (n < 0 ? "−" : "") + "RM " + Math.abs(Math.round(n)).toLocaleString("en-MY");
const hrs = n => n == null ? "—" : Math.round(n).toLocaleString("en-MY") + " h";
function valueOf(item){
  const v = item.value || {};
  const quote = num(v.quote), cost = num(v.cost), before = num(v.before), after = num(v.after);
  const rate = num(v.rate) ?? num(SETTINGS.valueRate);
  const costSave = quote == null ? null : quote - (cost || 0);
  const hrsMonth = before == null ? null : before - (after || 0);
  const hrsYear = hrsMonth == null ? null : hrsMonth * 12;
  const timeVal = hrsYear == null || rate == null ? null : hrsYear * rate;
  return {quote, cost, before, after, rate, costSave, hrsMonth, hrsYear, timeVal,
    total: (costSave||0) + (timeVal||0), has: quote != null || before != null};
}
// Modules of the projects in the current project filter, numbered like M-N1 per project.
function moduleRows(){
  const fp = $("#fProject").value;
  return PROJECTS.filter(p => !fp || p.key === fp)
    .flatMap(p => p.modules.map((m,i) => ({p, m, i, value:m.value, name:m.name, no:`${p.code}-${i+1}`})));
}
function valueTotals(rows){
  const vs = rows.map(valueOf).filter(v => v.has);
  const sum = k => vs.reduce((a,v) => a + (v[k]||0), 0);
  return {n: vs.length, costSave: sum("costSave"), hrsYear: sum("hrsYear"), timeVal: sum("timeVal"), total: sum("total")};
}
function valueTiles(rows){
  const v = valueTotals(rows), r = num(SETTINGS.valueRate);
  const tile = (label, value, sub) => el("div",{class:"kpi"}, el("div",{class:"eyebrow",text:label}), el("b",{text:value}), el("span",{class:"sub",text:sub}));
  return el("div",{class:"kpis vtiles"},
    tile("Cost savings", rm(v.costSave), "vendor quotes minus build cost"),
    tile("Time saved", hrs(v.hrsYear), `per year · ${hrs(v.hrsYear/12)} a month`),
    tile("Value of time saved", rm(v.timeVal), r == null ? "set a default hourly rate" : `per year · default RM ${r}/h`),
    tile("Total value", rm(v.total), `first year · ${v.n} module${v.n===1?"":"s"} with savings`));
}
function topValue(rows){
  const top = rows.map(r => [r, valueOf(r)]).filter(([,v]) => v.has && v.total > 0).sort((a,b) => b[1].total - a[1].total).slice(0,5);
  if (!top.length) return el("p",{class:"note", style:"margin:4px 0 0", text:"No savings entered yet. Add vendor quotes and hours saved for each module on the Value analysis page."});
  const mx = top[0][1].total;
  return el("div",{class:"topval"}, el("div",{class:"eyebrow", style:"margin-bottom:8px", text:"Top modules by first-year value"}),
    ...top.map(([r,v]) => el("div",{class:"tv-row", tabindex:"0", onclick:()=>setView("value"), "data-tip":`${r.p.key} · ${r.name}: ${rm(v.costSave)} cost + ${rm(v.timeVal)} time`},
      el("div",{class:"tv-nm"}, el("span",{class:"code", text:r.no+" "}), r.name, el("span",{class:"code", text:"  · "+r.p.key})),
      el("div",{class:"tv-bar"}, el("i",{style:`width:${100*v.total/mx}%`})),
      el("b",{class:"num", text:rm(v.total)}))));
}

let valueOnly = store.get("pm.valueOnly") === "1";
// Module values live in the settings document, so a save writes the latest settings with that one figure changed.
async function saveModuleValue(pid, name, k, raw){
  const s = normSettings(SETTINGS);
  const m = (s.projects.find(p => p.id === pid) || {modules:[]}).modules.find(x => x.name === name);
  if (!m){ toast("That module no longer exists"); return; }
  if (raw === "") delete m.value[k]; else m.value[k] = Number(raw);
  try { await dbRef.collection("settings").doc("config").set({...s, updatedAt:new Date().toISOString(), updatedBy: editor || "Manager"}); }
  catch(e){ toast("Could not save: " + (e.message||e.code)); }
}
async function saveRate(raw){
  try { await dbRef.collection("settings").doc("config").set({...SETTINGS, valueRate: raw === "" ? "" : Number(raw), updatedAt:new Date().toISOString(), updatedBy: editor || "Manager"}); toast("Default rate saved"); }
  catch(e){ toast("Could not save: " + (e.message||e.code)); }
}

const MCLS = {"Upcoming":"st-ns","In Progress":"st-ip","Complete":"st-ok"};
function renderValue(){
  const ed = canManage && canWrite;
  const q = $("#fSearch").value.trim().toLowerCase();
  const all = moduleRows();
  const list = all.filter(r => (!valueOnly || valueOf(r).has) && (!q || (r.name + " " + r.p.key).toLowerCase().includes(q)));
  // Save after focus has moved on, so Tab lands in the next box once the table redraws.
  const cell = (r, k, ph) => ed
    ? (() => { const i = el("input",{type:"number", min:"0", step:"any", class:"si vin", id:`val-${r.p.id}-${r.i}-${k}`, placeholder:ph||"", "aria-label":`${r.name} ${k}`});
        i.value = (r.value||{})[k] ?? ""; i.addEventListener("change", () => setTimeout(() => saveModuleValue(r.p.id, r.name, k, i.value), 0)); return i; })()
    : el("span",{class:"num", text: num((r.value||{})[k]) ?? ""});
  const rate = num(SETTINGS.valueRate);
  const rows = list.map(r => { const v = valueOf(r);
    return el("tr",{},
      el("td",{class:"code", text:r.no}),
      el("td",{}, el("div",{class:"nm", text:r.name})),
      el("td",{text:r.p.key}), el("td",{}, el("span",{class:"pill "+MCLS[r.m.status], text:r.m.status})),
      el("td",{}, cell(r,"quote")), el("td",{}, cell(r,"cost")), el("td",{class:"calc", text: v.costSave==null?"":rm(v.costSave)}),
      el("td",{}, cell(r,"before")), el("td",{}, cell(r,"after")), el("td",{class:"calc", text: v.hrsYear==null?"":hrs(v.hrsYear)}),
      el("td",{}, cell(r,"rate", rate==null?"":String(rate))), el("td",{class:"calc", text: v.timeVal==null?"":rm(v.timeVal)}),
      el("td",{class:"calc total", text: v.has ? rm(v.total) : ""}));
  });
  const T = valueTotals(list);
  const rateIn = ed ? el("input",{type:"number", min:"0", step:"any", class:"si w-num", id:"val-rate", value: rate ?? "", placeholder:"e.g. 25", "aria-label":"Default hourly rate"}) : el("b",{text: rate==null ? "not set" : `RM ${rate}`});
  if (ed) rateIn.addEventListener("change", () => saveRate(rateIn.value));
  const only = el("label",{class:"chk"}, el("input",{type:"checkbox", checked: valueOnly||null, onchange:e=>{ valueOnly = e.target.checked; store.set("pm.valueOnly", valueOnly?"1":"0"); render(); }}), " Only modules with savings entered");
  const toSettings = el("button",{class:"btn addrow", style:"margin:0", onclick:()=>setView("settings")}, "Edit modules in Settings");

  $("#v-value").replaceChildren(
    el("div",{class:"panel", style:"margin-top:14px"},
      el("div",{class:"phead"}, el("h2",{text:"Value analysis"}),
        el("div",{class:"rate"}, el("span",{class:"note", text:"Default hourly rate (RM)"}), rateIn)),
      valueTiles(all),
      el("p",{class:"note", style:"margin:0", text:"One row per module from Settings → Project details. Cost saving = vendor quote − build cost. Time saved = (manual hours a month before − after) × 12. Value of time = time saved × hourly rate (the module's own rate, or the default). Total = cost saving + one year of time value."})),
    el("div",{class:"vbar"}, el("div",{class:"tcount", text:`${list.length} module${list.length===1?"":"s"}`}), el("span",{class:"spacer"}), only, toSettings),
    all.length ? el("div",{class:"tablewrap"}, el("table",{class:"tasks vtable"},
      el("thead",{},
        el("tr",{class:"grp"}, el("th",{colspan:"4"}), el("th",{colspan:"3", text:"Cost"}), el("th",{colspan:"3", text:"Time (hours)"}), el("th",{colspan:"2", text:"Value of time"}), el("th")),
        el("tr",{}, ...["No.","Module","Project","Status","Vendor quote (RM)","Build cost (RM)","Cost saving","Manual h/month before","After","Saved / year","Rate (RM/h)","Per year","Total value"].map(h => el("th",{scope:"col", text:h})))),
      el("tbody",{}, ...rows),
      el("tfoot",{}, el("tr",{}, el("td",{colspan:"6", text:"Total"}), el("td",{class:"calc", text:rm(T.costSave)}), el("td",{colspan:"2"}),
        el("td",{class:"calc", text:hrs(T.hrsYear)}), el("td"), el("td",{class:"calc", text:rm(T.timeVal)}), el("td",{class:"calc total", text:rm(T.total)})))))
    : el("div",{class:"empty"}, el("b",{text:"No modules yet"}), "Add modules for each project under Settings → Project details, and they'll appear here."));
}

function card(t, showStatus){
  const draggable = canEditStatus(t);
  const c = el("div",{class:"card", tabindex:"0", draggable: draggable ? "true" : null, style:`--sc:var(${isOverdue(t)?"--late":SVAR[t.status]})`,
    onclick:()=>openSheet(t.id), onkeydown:e=>{if(e.key==="Enter")openSheet(t.id)},
    ondragstart:e=>{ e.dataTransfer.setData("text/plain", t.id); e.dataTransfer.effectAllowed="move"; }},
    el("div",{class:"meta"}, el("span",{class:"code",text:serial(t)}), el("span",{class:"pri "+t.priority, text:t.priority}), t.type?el("span",{text:t.type}):null,
      showStatus ? el("span",{class:"pill "+SCLS[t.status], style:"margin-left:auto", text:t.status}) : null),
    el("div",{class:"nm",text:t.name}),
    el("div",{class:"meta"},
      el("span",{text:(t.assignees||[]).join(", ")||"Unassigned"}),
      t.status==="Cancelled" ? (t.cancelled ? el("span",{text:"Cancelled "+fmt(t.cancelled)}) : null)
        : t.status==="Complete" ? (t.end ? el("span",{text:"Done "+fmt(t.end)}) : null)
        : t.due ? el("span",{class:"due"+(isOverdue(t)?" l":""), text: "Due "+fmt(t.due) + (isOverdue(t) ? ` · ${daysLate(t)}d late` : "")}) : null));
  return c;
}

const boardShowAll = {};
function renderBoard(){
  const list = filtered({ignoreStatus:true});
  const board = el("div",{class:"board"});
  ["Urgent", ...STATUSES].forEach(s => {
    let ts = s==="Urgent" ? list.filter(isUrgent) : list.filter(t=>t.status===s && !isUrgent(t));
    ts.sort(s==="Complete" ? (a,b)=>(b.end||"").localeCompare(a.end||"") : s==="Cancelled" ? (a,b)=>(b.cancelled||"").localeCompare(a.cancelled||"") : (a,b)=> (isOverdue(b)-isOverdue(a)) || PRIS.indexOf(a.priority)-PRIS.indexOf(b.priority) || (a.due||"9").localeCompare(b.due||"9"));
    const col = el("div",{class:"col"+(s==="Urgent"?" urgent":""),
      ondragover:e=>{e.preventDefault(); col.classList.add("drop");},
      ondragleave:()=>col.classList.remove("drop"),
      ondrop:e=>{ e.preventDefault(); col.classList.remove("drop"); const id=e.dataTransfer.getData("text/plain"); const t=tasks.find(x=>x.id===id); if (!t) return;
        if (s==="Urgent"){ if (t.priority!=="High") setPriority(t, "High"); } else if (t.status!==s) setStatus(t, s); }},
      el("h3",{}, s, el("span",{text:ts.length})));
    const LIMIT = 12;
    const shown = ((s==="Complete"||s==="Cancelled") && !boardShowAll[s]) ? ts.slice(0,LIMIT) : ts;
    shown.forEach(t => col.append(card(t, s==="Urgent")));
    if (shown.length < ts.length) col.append(el("button",{class:"more", onclick:()=>{boardShowAll[s]=true; render();}, text:`Show ${ts.length-shown.length} more`}));
    board.append(col);
  });
  $("#v-board").replaceChildren(board,
    el("p",{class:"note", style:"margin-top:10px", text: canManage ? "High-priority open tasks appear under Urgent. Drag a card to another column to change its status (or onto Urgent to make it High priority), or click it for details." : "Click a card for details. You can move your own tasks between columns."}));
}

function renderList(){
  const list = filtered();
  const cols = [
    ["order","No."],["name","Task"],["priority","Priority"],["status","Status"],["project","Project"],["type","Type"],
    ["assignees","Assigned to"],["start","Start"],["due","Due"],["end","Done"],["days","Days"]];
  const val = (t,k) => k==="order" ? (t.order||0)
    : k==="assignees" ? (t.assignees||[]).join(", ") : k==="days" ? (t.start&&t.end ? diffDays(t.end,t.start)+1 : -1)
    : k==="priority" ? PRIS.indexOf(t.priority) : k==="status" ? (isOverdue(t)?-1:STATUSES.indexOf(t.status)) : (t[k]||"");
  // Blanks sink to the bottom; ties fall back to the highest number first.
  const latest = (a,b) => (b.order||0)-(a.order||0);
  list.sort((a,b)=>{ let x=val(a,sortKey), y=val(b,sortKey);
    if (x===""||x===-1) return (y===""||y===-1) ? latest(a,b) : 1; if (y===""||y===-1) return -1;
    return (x<y?-1:x>y?1:0)*sortDir || latest(a,b); });
  paintSort();
  const thead = el("tr",{}, ...cols.map(([k,l]) => el("th",{scope:"col", "aria-sort": sortKey===k?(sortDir>0?"ascending":"descending"):null,
    onclick:()=>{ if (sortKey===k) sortDir=-sortDir; else {sortKey=k; sortDir=1;} render(); }, text:l})));
  const rows = list.map(t => {
    const d = t.start&&t.end ? diffDays(t.end,t.start)+1 : "";
    return el("tr",{tabindex:"0", onclick:()=>openSheet(t.id), onkeydown:e=>{if(e.key==="Enter")openSheet(t.id)}},
      el("td",{class:"code",text:serial(t)}),
      el("td",{}, el("div",{class:"nm",text:t.name}), t.link?el("a",{href:t.link.split(/\s/).find(x=>x.startsWith("http"))||t.link, target:"_blank", rel:"noopener", onclick:e=>e.stopPropagation(), class:"code", text:"open app ↗"}):null),
      el("td",{}, el("span",{class:"pri "+t.priority,text:t.priority})),
      el("td",{}, statusPill(t)),
      el("td",{text:t.project}), el("td",{text:t.type||""}),
      el("td",{text:(t.assignees||[]).join(", ")}),
      el("td",{class:"date",text:t.start?fmt(t.start):""}),
      el("td",{class:"date"+(isOverdue(t)?" l":""),text:t.due?fmt(t.due):""}),
      el("td",{class:"date"+(lateFinish(t)?" l":""),text:t.end?fmt(t.end):""}),
      el("td",{class:"date",text:d}));
  });
  $("#v-list").replaceChildren(el("div",{class:"tcount",text:`${list.length} task${list.length===1?"":"s"}`}),
    el("div",{class:"tablewrap"}, el("table",{class:"tasks"}, el("thead",{},thead), el("tbody",{},...rows))));
}

// Timeline zoom: pixels per day and how the header is ticked.
const ZOOMS = {day:{px:32, label:"Day"}, week:{px:9, label:"Week"}, month:{px:3, label:"Month"}, year:{px:0.9, label:"Year"}};
let tlZoom = ZOOMS[store.get("pm.tlzoom")] ? store.get("pm.tlzoom") : "week";
function timelineTicks(s0, e0){
  const ticks = [], d = new Date(s0);
  const step = () => tlZoom==="day" ? d.setDate(d.getDate()+1) : tlZoom==="week" ? d.setDate(d.getDate()+7) : d.setMonth(d.getMonth()+1);
  for (; d <= e0; step()){
    const m = d.getMonth(), day = d.getDate(); let label = "", strong = false;
    if (tlZoom==="day"){ strong = day===1; label = !strong ? String(day) : m===0 ? String(d.getFullYear()) : MON[m]; }
    else if (tlZoom==="week"){ strong = day<=7; label = strong ? `${MON[m]} ${day}` : String(day); }
    else if (tlZoom==="month"){ strong = m===0; label = `${MON[m]} ${d.getFullYear()}`; }
    else { strong = m===0; label = strong ? String(d.getFullYear()) : m%3===0 ? MON[m] : ""; }
    ticks.push({s:iso(d), label, strong});
  }
  return ticks;
}

function renderTimeline(){
  const all = filtered();
  const list = all.filter(t => t.start || t.due);
  const undated = all.length - list.length;
  const fp = $("#fProject").value;
  const projs = PROJECTS.filter(p => !fp || p.key === fp);

  // Project key dates, straight from Settings.
  const sumRows = projs.map(p => {
    const ts = all.filter(t => t.project === p.key), live = ts.filter(t => t.status !== "Cancelled");
    const done = ts.filter(t => t.status === "Complete").length, pct = live.length ? Math.round(100*done/live.length) : 0;
    return el("tr",{},
      el("td",{}, el("b",{text:p.key}), el("span",{class:"code", text:" "+p.code})),
      el("td",{class:"date", text:p.start ? fmt(p.start) : "—"}),
      el("td",{class:"date", text:p.duration ? `${p.duration} days` : "—"}),
      el("td",{class:"date", text:estEnd(p) ? fmt(estEnd(p)) : "—"}),
      el("td",{class:"date"}, p.actualEnd ? fmt(p.actualEnd) : el("span",{class:"pending", text:"Pending"})),
      el("td",{class:"num", text:ts.length}),
      el("td",{}, el("div",{class:"minibar"}, el("div",{class:"bar"}, el("i",{style:`width:${pct}%;background:var(--s-ok)`})), el("span",{class:"num", text:`${done}/${live.length} · ${pct}%`}))));
  });
  const summary = el("div",{class:"panel tl-sum"},
    el("div",{class:"tl-sumhead"}, el("h2",{text:"Project key dates"}),
      el("button",{class:"btn addrow", style:"margin:0", onclick:()=>setView("settings")}, "Edit in Settings")),
    el("div",{class:"swrap"}, el("table",{class:"stable tasks"},
      el("thead",{}, el("tr",{}, ...["Project","Start date","Duration","Est. end date","Actual completion","Total tasks","Complete"].map(h => el("th",{scope:"col",text:h})))),
      el("tbody",{}, ...sumRows))));

  if (!list.length){ $("#v-timeline").replaceChildren(summary, el("div",{class:"empty"}, el("b",{text:"No dated tasks"}), "Tasks need a start or due date to appear on the timeline.")); return; }
  let min = TODAY, max = TODAY;
  const span = d => { if (d){ if (d<min) min=d; if (d>max) max=d; } };
  list.forEach(t => [t.start,t.due,t.end].forEach(span));
  projs.forEach(p => { if (list.some(t => t.project === p.key)) [p.start, estEnd(p), p.actualEnd].forEach(span); });
  const s0 = parse(min), e0 = parse(max);
  if (tlZoom==="day"){ s0.setDate(s0.getDate()-3); e0.setDate(e0.getDate()+7); }
  else if (tlZoom==="week"){ s0.setDate(s0.getDate() - ((s0.getDay()+6)%7) - 7); e0.setDate(e0.getDate()+21); }
  else if (tlZoom==="month"){ s0.setDate(1); s0.setMonth(s0.getMonth()-1); e0.setDate(1); e0.setMonth(e0.getMonth()+2); }
  else { s0.setMonth(0, 1); e0.setFullYear(e0.getFullYear()+1, 0, 1); }
  const start = iso(s0); const days = diffDays(iso(e0), start);
  const LW = matchMedia("(max-width:600px)").matches ? 170 : 360;
  // Stretch a short range to fill the panel instead of leaving empty space on the right.
  const avail = ($("#v-timeline").clientWidth || 1200) - LW - 2;
  const PX = Math.max(ZOOMS[tlZoom].px, avail / days), MINW = Math.max(PX, 4);
  const W = days * PX;
  const x = d => diffDays(d, start) * PX;

  const head = el("div",{class:"tl-head"}, el("div",{class:"tl-label",text:"Task"}));
  const htrack = el("div",{class:"tl-track", style:`width:${W}px`});
  const grid = [];
  timelineTicks(s0, e0).forEach(t => {
    htrack.append(el("div",{class:"tl-week"+(t.strong?" mo":""), style:`left:${x(t.s)}px`, text:t.label}));
    grid.push(x(t.s));
  });
  head.append(htrack);
  const inner = el("div",{class:"tl-inner"}, head);
  const body = el("div",{style:"position:relative"});
  PROJECTS.forEach(p => {
    const ts = list.filter(t=>t.project===p.key).sort((a,b)=>(b.order||0)-(a.order||0)); // latest number first, like Tasks
    if (!ts.length) return;
    const total = all.filter(t => t.project === p.key).length;
    const gtrack = el("div",{class:"tl-track",style:`width:${W}px`});
    const pe = p.actualEnd || estEnd(p);
    if (p.start && pe) gtrack.append(el("div",{class:"tl-proj", style:`left:${x(p.start)}px;width:${Math.max(MINW,(diffDays(pe,p.start)+1)*PX)}px`,
      title:`${p.key}: ${fmt(p.start)} – ${fmt(pe)}${p.actualEnd ? " (completed)" : " (estimated)"}`},
      el("span",{text:`${fmt(p.start)} → ${p.actualEnd ? "done " : "est. "}${fmt(pe)}`})));
    body.append(el("div",{class:"tl-row grp"},
      el("div",{class:"tl-label"}, el("div",{}, p.key, el("small",{text:` ${total} task${total===1?"":"s"}`}))), gtrack));
    ts.forEach(t => {
      const tr = el("div",{class:"tl-track", style:`width:${W}px;--sc:var(${isOverdue(t)?"--late":SVAR[t.status]})`});
      const ps = t.start || t.due, pe = t.due || t.start;
      tr.append(el("div",{class:"tl-plan", style:`left:${x(ps)}px;width:${Math.max(MINW,(diffDays(pe,ps)+1)*PX)}px`, title:`Planned ${fmt(ps)} – ${fmt(pe)}`}));
      if (t.start && (t.end || t.status==="In Progress")){
        const ae = t.end || TODAY;
        if (ae >= t.start) tr.append(el("div",{class:"tl-act", style:`left:${x(t.start)}px;width:${Math.max(MINW/2,(diffDays(ae,t.start)+1)*PX)}px`, title: t.end?`Actual ${fmt(t.start)} – ${fmt(t.end)}`:`Started ${fmt(t.start)}, still open`}));
      }
      if (t.due) tr.append(el("div",{class:"tl-due", style:`left:${x(t.due)+Math.max(PX,1)-1}px`, title:`Due ${fmt(t.due)}`}));
      body.append(el("div",{class:"tl-row"},
        el("div",{class:"tl-label", title:t.name, tabindex:"0", onclick:()=>openSheet(t.id), onkeydown:e=>{if(e.key==="Enter")openSheet(t.id)}}, t.name), tr));
    });
  });
  grid.forEach(g => body.append(el("div",{class:"tl-grid", style:`left:${LW+g}px`})));
  body.append(el("div",{class:"tl-today", style:`left:${LW+x(TODAY)+PX/2}px`}, el("span",{text:"Today"})));
  inner.append(body);
  const wrap = el("div",{class:"tl"}, inner);
  const key = el("div",{class:"tl-key"},
    el("span",{}, el("i",{style:"width:22px;height:10px;border-radius:3px;background:var(--s-ip);opacity:.25"}), "Planned (start to due)"),
    el("span",{}, el("i",{style:"width:22px;height:6px;border-radius:2px;background:var(--s-ip)"}), "Actual work"),
    el("span",{}, el("i",{style:"width:2px;height:12px;background:var(--fg);opacity:.5"}), "Due date"),
    el("span",{}, el("i",{style:"width:10px;height:10px;border-radius:2px;background:var(--late)"}), "Overdue"),
    el("span",{}, el("i",{style:"width:22px;height:10px;border-radius:3px;border:1.5px solid var(--accent)"}), "Project start to end date"),
    undated ? el("span",{text:`${undated} task${undated===1?"":"s"} without dates not shown`}) : null);
  const zoom = el("div",{class:"tl-bar"}, el("span",{class:"note", text:"View by"}),
    el("div",{class:"seg", role:"group", "aria-label":"Timeline scale"}, ...Object.entries(ZOOMS).map(([k,z]) =>
      el("button",{"aria-pressed": String(k===tlZoom), onclick:()=>{ tlZoom = k; store.set("pm.tlzoom", k); render(); }}, z.label))));
  $("#v-timeline").replaceChildren(summary, zoom, wrap, key);
  requestAnimationFrame(() => { wrap.scrollLeft = Math.max(0, x(TODAY) - wrap.clientWidth*0.6); });
}

// ---------- settings ----------
let sDraft = null, sDirty = false;
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2,5);

function renderSettings(){
  if (!sDraft || !sDirty) sDraft = normSettings(SETTINGS);
  const d = sDraft, ro = !(canManage && canWrite);
  const root = $("#v-settings");
  const bar = el("div",{class:"savebar"});
  const paintBar = () => bar.replaceChildren(
    el("span",{class:"note", text: ro ? "Only the tracker owner can change settings." : sDirty ? "You have unsaved changes." : "All changes saved."}),
    el("span",{class:"spacer"}),
    ro ? null : el("button",{class:"btn", disabled: sDirty?null:true, onclick:()=>{ sDirty=false; renderSettings(); }}, "Discard"),
    ro ? null : el("button",{class:"btn primary", disabled: sDirty?null:true, onclick:saveSettings}, "Save settings"));
  const touch = () => { if (!sDirty){ sDirty = true; paintBar(); } };
  const redraw = () => { sDirty = true; renderSettings(); };

  const inp = (obj, key, o={}) => {
    const i = el("input",{type:o.type||"text", class:"si"+(o.cls?" "+o.cls:""), "aria-label":o.label, placeholder:o.ph||null,
      list:o.list||null, min:o.min||null, disabled: ro||null});
    i.value = obj[key] ?? "";
    i.addEventListener("input", () => { obj[key] = o.type==="number" ? (i.value===""?"":Number(i.value)) : i.value; touch(); o.after && o.after(); });
    return i;
  };
  const rm = (label, onclick, why) => ro ? null : el("button",{class:"rm", "aria-label":"Remove "+label, title: why || "Remove", disabled: why?true:null, onclick}, "×");
  const add = (label, onclick) => ro ? null : el("button",{class:"btn addrow", onclick}, "+ " + label);
  const thead = (...hs) => el("thead",{}, el("tr",{}, ...hs.map(h => el("th",{scope:"col", text:h}))));
  const usedBy = name => tasks.filter(t => t.project === name).length;
  const oldName = p => (SETTINGS.projects.find(x=>x.id===p.id)||p).name;

  // Project key dates
  const pRows = d.projects.map((p,i) => {
    const endCell = el("td",{class:"date"});
    const paintEnd = () => endCell.textContent = estEnd(p) ? fmtY(estEnd(p)) : "—";
    const actCell = el("div",{class:"act"});
    const paintAct = () => { const pend = actCell.querySelector(".pending"); if (pend) pend.hidden = !!p.actualEnd; };
    actCell.append(ro ? el("span",{text: p.actualEnd ? fmtY(p.actualEnd) : ""}) : inp(p,"actualEnd",{type:"date", label:`${p.name} actual end date`, after:paintAct}),
      el("span",{class:"pending", text:"Pending"}));
    paintEnd(); paintAct();
    const n = usedBy(oldName(p));
    return el("tr",{},
      el("td",{class:"idx", text:i+1}),
      el("td",{}, inp(p,"name",{label:"Project name", ph:"Project name"})),
      el("td",{}, inp(p,"code",{label:`${p.name} code`, cls:"w-code", ph:"Code"})),
      el("td",{}, ro ? el("span",{class:"date",text:p.start?fmtY(p.start):"—"}) : inp(p,"start",{type:"date", label:`${p.name} start date`, after:paintEnd})),
      el("td",{}, el("div",{class:"dur"}, inp(p,"duration",{type:"number", min:"1", cls:"w-num", label:`${p.name} duration in days`, after:paintEnd}), el("span",{class:"note",text:"days"}))),
      endCell, el("td",{}, actCell),
      el("td",{class:"num", text:n}),
      el("td",{}, rm(p.name, () => { d.projects.splice(i,1); redraw(); }, n ? `${n} task${n===1?" uses":"s use"} this project` : null)));
  });
  const projPanel = el("div",{class:"panel"},
    el("h2",{text:"Project key dates"}),
    el("div",{class:"swrap"}, el("table",{class:"stable wide"},
      thead("#","Project name","Code","Start date","Duration","Est. end date","Actual end date","Tasks",""),
      el("tbody",{}, ...pRows))),
    add("Add project", () => { d.projects.push({id:uid("p"), name:"", code:"", start:"", duration:180, actualEnd:"", modules:[]}); redraw(); }),
    el("p",{class:"note", text:"Est. end date is the start date plus the duration. Renaming a project also moves its tasks to the new name."}));

  // Status / Priority / Type
  const statusPanel = el("div",{class:"panel"}, el("h2",{text:"Status"}),
    el("table",{class:"stable"}, el("tbody",{}, ...STATUSES.map((s,i) => el("tr",{}, el("td",{class:"idx",text:i+1}), el("td",{}, el("span",{class:"pill "+SCLS[s], text:s})))))),
    el("p",{class:"note", text:"Statuses set the board columns and the overdue rules, so they are fixed."}));
  const listPanel = (title, arr, ph) => el("div",{class:"panel"}, el("h2",{text:title}),
    el("table",{class:"stable"}, el("tbody",{}, ...arr.map((v,i) => el("tr",{},
      el("td",{class:"idx",text:i+1}), el("td",{}, inp(arr,i,{label:`${title} ${i+1}`, ph})),
      el("td",{class:"x"}, rm(v, () => { arr.splice(i,1); redraw(); })))))),
    add("Add", () => { arr.push(""); redraw(); }));

  // Team
  const teamPanel = el("div",{class:"panel"}, el("h2",{text:"Team"}),
    el("table",{class:"stable"}, thead("#","Assignee",""), el("tbody",{}, ...d.team.map((m,i) => el("tr",{},
      el("td",{class:"idx",text:i+1}), el("td",{}, inp(m,"name",{label:"Assignee name", ph:"Name"})),
      el("td",{class:"x"}, rm(m.name, () => { d.team.splice(i,1); redraw(); })))))),
    add("Add person", () => { d.team.push({id:uid("m"), name:""}); redraw(); }),
    el("p",{class:"note", text:"Renaming someone also updates the tasks assigned to them."}));

  // System / Module per project
  const modPanels = d.projects.map(p => el("div",{class:"panel"},
    el("div",{class:"eyebrow", text:`${p.name || "New project"} project details`}),
    el("h2",{style:"margin-top:4px", text:"System / Module"}),
    p.modules.length ? el("table",{class:"stable"}, el("tbody",{}, ...p.modules.map((m,i) => el("tr",{},
      el("td",{class:"idx",text:i+1}), el("td",{}, inp(m,"name",{label:`${p.name} module ${i+1}`, ph:"System or module name"})),
      el("td",{class:"mst"}, (() => {
        const sel = el("select",{class:"si mstat", "data-s":m.status, "aria-label":`${m.name} status`, disabled: ro||null},
          ...MSTAT.map(x => el("option",{value:x, text:x})));
        sel.value = m.status;
        sel.addEventListener("change", () => { m.status = sel.value; sel.dataset.s = sel.value; touch(); });
        return sel; })()),
      el("td",{class:"x"}, rm(m.name, () => { p.modules.splice(i,1); redraw(); }))))))
      : el("p",{class:"note", text:"No systems or modules yet."}),
    add("Add module", () => { p.modules.push({name:"", status:"Upcoming"}); redraw(); })));

  paintBar();
  root.replaceChildren(el("div",{class:"settings"},
    projPanel,
    el("div",{class:"sgrid lookups"}, statusPanel, listPanel("Priority", d.priorities, "Priority"), listPanel("Type", d.types, "Type"), teamPanel),
    el("h2",{class:"shead", text:"Project details"}),
    el("div",{class:"sgrid wide"}, ...modPanels),
    bar));
}

async function saveSettings(){
  const s = normSettings(sDraft);
  s.projects = s.projects.map(p => ({...p, name:p.name.trim(), code:p.code.trim(), modules:p.modules.map(m=>({...m, name:m.name.trim()})).filter(m=>m.name)})).filter(p => p.name);
  // Module savings are edited on the Value analysis page, so keep the latest saved figures (matched by project + module name).
  s.projects.forEach(p => { const live = SETTINGS.projects.find(x => x.id === p.id);
    p.modules.forEach(m => { const lm = live && live.modules.find(x => x.name === m.name); if (lm) m.value = {...lm.value}; }); });
  s.team = s.team.map(m => ({...m, name:m.name.trim()})).filter(m => m.name);
  s.priorities = s.priorities.map(x=>x.trim()).filter(Boolean);
  s.types = s.types.map(x=>x.trim()).filter(Boolean);
  const dup = arr => arr.find((x,i) => arr.indexOf(x) !== i);
  const dp = dup(s.projects.map(p=>p.name)), dm = dup(s.team.map(m=>m.name));
  if (dp) return toast(`Two projects are called “${dp}”`);
  if (dm) return toast(`“${dm}” is listed twice in Team`);
  if (!s.projects.length) return toast("Add at least one project");

  // Carry renames over to the tasks that use the old names.
  const pRen = {}, mRen = {};
  SETTINGS.projects.forEach(p => { const n = s.projects.find(x=>x.id===p.id); if (n && p.name && n.name !== p.name) pRen[p.name] = n.name; });
  SETTINGS.team.forEach(m => { const n = s.team.find(x=>x.id===m.id); if (n && m.name && n.name !== m.name) mRen[m.name] = n.name; });
  const moved = tasks.filter(t => pRen[t.project] || (t.assignees||[]).some(a => mRen[a]));
  try {
    await dbRef.collection("settings").doc("config").set({...s, updatedAt:new Date().toISOString(), updatedBy: editor || "Manager"});
    for (const t of moved) await dbRef.doc("tasks/"+t.id).update({project: pRen[t.project] || t.project, assignees:(t.assignees||[]).map(a => mRen[a] || a)});
    sDirty = false; applySettings(s); refreshPickers(); renderSettings(); render();
    toast(moved.length ? `Settings saved · ${moved.length} task${moved.length===1?"":"s"} updated` : "Settings saved");
  } catch(e){ toast("Could not save settings: " + (e && (e.message||e.code))); }
}

// ---------- sheet ----------
function closeSheet(){ openId = null; $("#sheetRoot").replaceChildren(); }
document.addEventListener("keydown", e => { if (e.key === "Escape" && openId !== null) closeSheet(); });

// ---------- task versions ----------
// "Audit System", "Modify - Audit System ver 2.0" and "Audit System (Modify - ver. 3.0)" are one family.
const VER_RE = /\bver\.?\s*(\d+)(?:\.\d+)?/i;
function stripVersion(name){
  return (name||"").replace(/\(\s*modify\s*-\s*ver\.?\s*\d+(?:\.\d+)?\s*\)/i, "").replace(/^\s*modify\s*-\s*/i, "")
    .replace(VER_RE, "").replace(/\s+/g, " ").replace(/\s+\)/g, ")").trim();
}
const baseKey = name => stripVersion(name).toLowerCase();
function family(t){ const k = baseKey(t.name); return tasks.filter(x => baseKey(x.name) === k).sort((a,b)=>(a.order||0)-(b.order||0)); }
// Next version: one past the highest "ver N" in the family; unnumbered tasks count as one version each.
function nextVersion(fam){
  const nums = fam.map(x => +((x.name.match(VER_RE)||[])[1] || 0));
  return Math.max(fam.length, ...nums) + 1;
}
function modifyDraft(src){
  const fam = family(src), latest = fam[fam.length-1] || src;
  const original = fam.find(x => stripVersion(x.name) === x.name.trim()) || latest;
  const n = nextVersion(fam);
  return {name:`${stripVersion(original.name)} (Modify - ver. ${n}.0)`, project:latest.project, type:latest.type,
    priority:latest.priority, assignees:[...(latest.assignees||[])], link:latest.link||"", modifies:latest.id,
    _ver:{n, base:stripVersion(original.name), count:fam.length}};
}

function openSheet(id, prefill){
  const isNew = id === "new";
  const t = isNew ? {id:"", project: $("#fProject").value || (PROJECTS[0]||{}).key || "", type: TYPES.includes("Web") ? "Web" : TYPES[0]||"", name:"", priority: PRIS.includes("Medium") ? "Medium" : PRIS[0]||"", status:"Not Started",
      assignees: me ? [me] : [], start:"", due:"", end:"", link:"", notes:"", ...(prefill||{})} : tasks.find(x=>x.id===id);
  if (!t) return closeSheet();
  openId = id;
  const full = canManage && canWrite;
  const statusOk = isNew || canEditStatus(t);
  const draft = {...t, assignees:[...(t.assignees||[])]};

  const field = (label, key, kind="text", opts={}) => {
    const wrap = el("div",{class:"f"+(opts.full?" full":"")}, el("label",{for:"f-"+key, text:label}));
    if (!full && !(opts.statusEditable && statusOk)){
      let v = draft[key]; if (key==="assignees") v = v.join(", ");
      if (kind==="date") v = v ? fmtY(v) : "—";
      if (key==="link" && v){ const href = v.split(/\s/).find(s=>s.startsWith("http")) || v;
        wrap.append(el("div",{class:"ro"}, el("a",{href, target:"_blank", rel:"noopener", text:v}))); return wrap; }
      wrap.append(el("div",{class:"ro", text: v || "—", style:"white-space:pre-wrap"})); return wrap;
    }
    let input;
    if (key==="assignees"){
      // Tick boxes from Settings > Team; anyone already assigned but no longer in Team stays visible.
      const names = [...TEAM, ...draft.assignees.filter(a => !TEAM.includes(a))];
      wrap.append(names.length ? el("div",{class:"picks", id:"f-assignees", role:"group"}, ...names.map(n => {
        const cb = el("input",{type:"checkbox", value:n, checked: draft.assignees.includes(n) || null});
        cb.addEventListener("change", () => { draft.assignees = names.filter(x => x===n ? cb.checked : draft.assignees.includes(x)); });
        return el("label",{class:"pick"}, cb, n);
      })) : el("div",{class:"ro note", text:"Add people under Settings → Team first."}));
      return wrap;
    }
    if (kind==="select"){
      // Keep a value that was since removed in Settings, so saving doesn't silently change it.
      const items = draft[key] && !opts.items.includes(draft[key]) ? [draft[key], ...opts.items] : opts.items;
      input = el("select",{id:"f-"+key}, opts.blank ? el("option",{value:"",text:"—"}) : null, ...items.map(i=>el("option",{value:i,text:i})));
    }
    else if (kind==="textarea") input = el("textarea",{id:"f-"+key});
    else input = el("input",{id:"f-"+key, type:kind, list: opts.list||null, placeholder: opts.ph||null});
    input.value = key==="assignees" ? draft.assignees.join(", ") : (draft[key]||"");
    input.addEventListener("input", () => { draft[key] = key==="assignees" ? input.value.split(",").map(s=>s.trim()).filter(Boolean) : input.value; });
    wrap.append(input); return wrap;
  };

  const sbtns = el("div",{class:"statusbtns", role:"group", "aria-label":"Status"});
  const paintS = () => sbtns.querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.s === draft.status));
  STATUSES.forEach(s => sbtns.append(el("button",{class:SCLS[s], "data-s":s, disabled: statusOk?null:true, onclick:()=>{
    draft.status = s;
    if (s==="Complete" && !draft.end){ draft.end = TODAY; const i=$("#f-end"); if (i) i.value = TODAY; }
    if (s==="In Progress" && !draft.start){ draft.start = TODAY; const i=$("#f-start"); if (i) i.value = TODAY; }
    if (s!=="Complete" && t.status==="Complete"){ draft.end = ""; const i=$("#f-end"); if (i) i.value = ""; }
    draft.cancelled = s==="Cancelled" ? (t.status==="Cancelled" && t.cancelled || TODAY) : "";
    paintS(); if (!full && !isNew) save(); }}, s)));
  paintS();

  const fields = el("div",{class:"fields"},
    full ? field("Task name","name","text",{full:true}) : null,
    isNew && full ? el("div",{class:"f full", id:"f-similar"}) : null,
    field("Project","project","select",{items:PROJECTS.map(p=>p.key)}),
    field("Type","type","select",{items:TYPES}),
    field("Priority","priority","select",{items:PRIS}),
    field("Assigned to","assignees","text",{full:true}),
    field("Start date","start","date",{statusEditable:true}),
    field("Due date","due","date"),
    field("Completed on","end","date",{statusEditable:true}),
    t.status==="Cancelled" ? field("Cancelled on","cancelled","date",{statusEditable:true}) : null,
    el("div",{class:"f"}, el("label",{text:"Days taken"}), el("div",{class:"ro num", text: t.start&&t.end ? `${diffDays(t.end,t.start)+1} days` + (t.due ? (t.end<=t.due?" · on time":` · ${diffDays(t.end,t.due)}d late`) : "") : "—"})),
    field("App link","link","text",{full:true, ph:"https://"}),
    field("Notes","notes","textarea",{full:true, statusEditable:true}));

  const footer = el("footer",{});
  const toastNote = t.updatedBy ? el("span",{class:"note", text:`Last update by ${t.updatedBy}${t.updatedAt?" · "+fmtY(t.updatedAt.slice(0,10)):""}`}) : null;
  if (full || (statusOk && !isNew)){
    footer.append(el("button",{class:"btn primary", onclick:()=>save()}, isNew?"Add task":"Save changes"));
    if (full && !isNew) footer.append(el("button",{class:"btn danger", onclick:()=>{
      footer.replaceChildren(el("div",{class:"confirm"}, `Delete “${t.name}”?`, el("span",{class:"spacer"}),
        el("button",{class:"btn danger", onclick:async()=>{ try { await dbRef.doc("tasks/"+t.id).delete(); toast("Task deleted"); closeSheet(); } catch(e){ toast("Could not delete: "+(e.message||e.code)); } }}, "Delete"),
        el("button",{class:"btn", onclick:()=>openSheet(id)}, "Keep it")));
    }}, "Delete"));
  }
  footer.append(el("span",{class:"spacer"}));
  const fnote = toastNote || (!statusOk ? el("span",{class:"note", text:"Only the tracker owner can update tasks."}) : null);
  if (fnote) footer.append(fnote);

  async function save(){
    if (full && !draft.name.trim()){ toast("Give the task a name first"); return; }
    const by = editor || (canManage ? "Manager" : "Someone");
    const body = full ? {project:draft.project, type:draft.type, name:draft.name.trim(), priority:draft.priority, status:draft.status,
      assignees:draft.assignees, start:draft.start||"", due:draft.due||"", end:draft.end||"", cancelled:draft.cancelled||"", link:draft.link||"", notes:draft.notes||""}
      : {status:draft.status, start:draft.start||"", end:draft.end||"", cancelled:draft.cancelled||"", notes:draft.notes||""};
    body.updatedAt = new Date().toISOString(); body.updatedBy = by;
    try {
      if (isNew){
        const nid = "t" + Date.now().toString(36);
        body.order = Math.max(0, ...tasks.map(x=>x.order||0)) + 1; body.id = nid; body.createdAt = body.updatedAt;
        if (draft.modifies) body.modifies = draft.modifies;
        await dbRef.collection("tasks").doc(nid).set(body); toast("Task added"); closeSheet();
      } else {
        await dbRef.doc("tasks/"+t.id).update(body); toast("Saved");
      }
    } catch(e){
      if (e && e.code === "invalid_argument" && !full){ canWrite = false; render(); toast("You don't have permission to update tasks"); }
      else toast("Could not save: " + (e && (e.message||e.code)));
    }
  }

  const sheet = el("aside",{class:"sheet", role:"dialog", "aria-modal":"true", "aria-label": isNew?"New task":t.name},
    el("header",{}, el("div",{},
      el("div",{class:"eyebrow", text: isNew ? "New task" : `${serial(t)} · ${t.project}`}),
      el("h2",{text: isNew ? "Add a task" : t.name})),
      el("button",{class:"x", "aria-label":"Close", onclick:closeSheet}, "×")),
    el("div",{class:"body"},
      el("div",{}, el("div",{class:"eyebrow", style:"margin-bottom:6px", text:"Status"}), sbtns,
        isOverdue(t) && !isNew ? el("p",{class:"late-tag", style:"margin:8px 0 0", text:`${daysLate(t)} days past the due date`}) : null),
      fields),
    footer);
  $("#sheetRoot").replaceChildren(el("div",{class:"scrim", onclick:closeSheet}), sheet);
  const first = sheet.querySelector(full?"#f-name":".x"); first && first.focus();

  // New task: as the name is typed, list earlier tasks with that name and offer "Modify" to start the next version.
  const sim = sheet.querySelector("#f-similar"), nameIn = sheet.querySelector("#f-name");
  if (sim && nameIn){
    const paint = () => {
      if (draft._ver){
        sim.replaceChildren(el("div",{class:"vernote"}, el("b",{text:`Version ${draft._ver.n}.0`}),
          ` of “${draft._ver.base}” · ${draft._ver.count} earlier version${draft._ver.count===1?"":"s"}`));
        return;
      }
      const q = baseKey(nameIn.value);
      if (q.length < 2){ sim.replaceChildren(); return; }
      const seen = new Set(), fams = [];
      [...tasks].sort((a,b)=>(b.order||0)-(a.order||0)).forEach(x => {
        const k = baseKey(x.name);
        if (seen.has(k) || !(k.includes(q) || x.name.toLowerCase().includes(nameIn.value.trim().toLowerCase()))) return;
        seen.add(k); fams.push(family(x));
      });
      if (!fams.length){ sim.replaceChildren(); return; }
      sim.replaceChildren(el("label",{text:"Done before"}), el("ul",{class:"similar"}, ...fams.slice(0,6).map(fam => {
        const latest = fam[fam.length-1];
        return el("li",{},
          el("div",{class:"t"}, el("div",{text:latest.name}),
            el("small",{text:`${serial(latest)} · ${latest.status}${fam.length>1?` · ${fam.length} versions`:""}`})),
          el("button",{class:"btn", type:"button", onclick:()=>openSheet("new", modifyDraft(latest))}, `Modify → ver. ${nextVersion(fam)}.0`));
      })));
    };
    nameIn.addEventListener("input", () => { draft._ver = null; draft.modifies = ""; paint(); });
    paint();
  }
}
$("#addBtn").addEventListener("click", () => openSheet("new"));

async function setPriority(t, p){
  if (!canEditStatus(t)){ toast("Only the tracker owner can update tasks"); return; }
  try { await dbRef.doc("tasks/"+t.id).update({priority:p, updatedAt:new Date().toISOString(), updatedBy: editor || "Manager"}); toast(`Marked ${p} priority`); }
  catch(e){ toast("Could not update: " + (e.message||e.code)); }
}

async function setStatus(t, s){
  if (!canEditStatus(t)){ toast("Only the tracker owner can update tasks"); return; }
  const body = {status:s, updatedAt:new Date().toISOString(), updatedBy: editor || "Manager"};
  if (s==="Complete" && !t.end) body.end = TODAY;
  if (s==="In Progress" && !t.start) body.start = TODAY;
  if (s!=="Complete" && t.status==="Complete") body.end = "";
  body.cancelled = s==="Cancelled" ? TODAY : "";
  try { await dbRef.doc("tasks/"+t.id).update(body); toast(`Moved to ${s}`); }
  catch(e){ toast("Could not update: " + (e.message||e.code)); }
}

let toastTimer;
function toast(msg){
  clearTimeout(toastTimer);
  let t = document.querySelector(".toast"); if (!t){ t = el("div",{class:"toast", role:"status"}); document.body.append(t); }
  t.textContent = msg; toastTimer = setTimeout(()=>t.remove(), 2600);
}


// ---------- storage ----------
// Inside a Claude artifact the page uses Claude's shared database.
// Anywhere else it uses this browser-only store (localStorage), seeded from data.js.
// Tasks live in the "tasks" collection; the Settings tab is one "settings/config" document.
// To share live data across the team when self-hosting, replace makeLocalDb()
// with an adapter for your own backend (Firebase, Supabase, etc.) exposing the same calls.
function makeLocalDb(seeds){
  const KEYS = {tasks:"pm.tasks.v1", settings:"pm.settings.v1"};
  const cols = {};
  const col = name => cols[name] || (cols[name] = (() => {
    const KEY = KEYS[name] || `pm.${name}.v1`;
    const listeners = new Set();
    const fromSeed = () => Object.fromEntries((seeds[name]||[]).map(t => [t.id, t]));
    let data;
    try { data = JSON.parse(localStorage.getItem(KEY)); } catch { data = null; }
    if (!data || typeof data !== "object") data = fromSeed();
    const persist = () => { try { localStorage.setItem(KEY, JSON.stringify(data)); } catch {} };
    const emit = () => { const docs = Object.values(data).map(d => ({id:d.id, data:() => d}));
      listeners.forEach(fn => fn({docs, size:docs.length, empty:!docs.length})); };
    const docRef = id => ({
      async set(body){ data[id] = {...body, id}; persist(); emit(); },
      async update(body){ if (!data[id]) throw {code:"invalid_argument", message:"Not found"}; data[id] = {...data[id], ...body}; persist(); emit(); },
      async delete(){ delete data[id]; persist(); emit(); }
    });
    persist();
    return {docRef, listeners, emit, all:() => data, reset(){ data = fromSeed(); persist(); emit(); }};
  })());
  return {
    doc(path){ const [c, id] = path.split("/"); return col(c).docRef(id); },
    collection(name){ const c = col(name); return { doc: id => c.docRef(id), onSnapshot(fn){ c.listeners.add(fn); setTimeout(c.emit, 0); return () => c.listeners.delete(fn); } }; },
    exportJSON(){ return JSON.stringify(Object.values(col("tasks").all()), null, 1); },
    reset(){ col("tasks").reset(); col("settings").reset(); }
  };
}

function watchSettings(db){
  db.collection("settings").onSnapshot(snap => {
    const doc = snap.docs.find(d => d.id === "config");
    applySettings(doc ? doc.data() : window.SEED_SETTINGS);
    refreshPickers(); render();
  }, () => {});
}


// ---------- Supabase ----------
// Used when supabaseconfig.js has your Project URL and anon key. Tables: public.tasks and public.settings
// (see supabase_schema.sql). The app's field names are mapped to the table's column names here.
const TASK_MAP = {start:"start_date", due:"due_date", end:"end_date", cancelled:"cancelled_date", order:"sort_order",
  createdAt:"created_at", updatedAt:"updated_at", updatedBy:"updated_by"};
const SET_MAP = {valueRate:"value_rate", updatedAt:"updated_at", updatedBy:"updated_by"};
const COLS = {
  tasks: new Set(["id","project","type","name","priority","status","assignees","start_date","due_date","end_date","cancelled_date",
    "link","notes","sort_order","modifies","value","created_at","updated_at","updated_by"]),
  settings: new Set(["id","projects","priorities","types","team","value_rate","updated_at","updated_by"])
};
const DATE_COLS = new Set(["start_date","due_date","end_date","cancelled_date"]);
const mapFor = table => table === "tasks" ? TASK_MAP : SET_MAP;
function toRow(table, obj){
  const map = mapFor(table), r = {};
  for (const [k,v] of Object.entries(obj||{})){
    const c = map[k] || k; if (!COLS[table].has(c)) continue;
    if (DATE_COLS.has(c)) r[c] = v || null;
    else if (c === "value_rate") r[c] = v === "" || v == null ? null : Number(v);
    else if (c === "modifies") r[c] = v || null;
    else r[c] = v;
  }
  return r;
}
function fromRow(table, row){
  const inv = Object.fromEntries(Object.entries(mapFor(table)).map(([a,b]) => [b,a])), o = {};
  for (const [c,v] of Object.entries(row||{})){
    const k = inv[c] || c;
    if (DATE_COLS.has(c)) o[k] = v || "";
    else if (v == null && ["link","notes","type"].includes(k)) o[k] = "";
    else if (v == null && (k === "modifies" || k === "valueRate")) { if (k === "valueRate") o[k] = ""; }
    else o[k] = v;
  }
  return o;
}
function makeSupabaseDb(sb){
  const reloads = {};
  const wrap = e => ({code:"unavailable", message: e && /row-level security|permission|42501/i.test((e.code||"")+(e.message||""))
    ? "Supabase refused the change. Its table policies need to allow edits without signing in." : (e && e.message ? e.message : String(e))});
  const notSaved = {code:"unavailable", message:"Not saved. Supabase didn't accept the change: check the table policies allow edits (or the item no longer exists)."};
  const after = table => { const r = reloads[table]; if (r) r(); };
  const docRef = (table, id) => ({
    async set(body){ const {error} = await sb.from(table).upsert({...toRow(table, body), id}); if (error) throw wrap(error); after(table); },
    async update(body){ const {data, error} = await sb.from(table).update(toRow(table, body)).eq("id", id).select("id");
      if (error) throw wrap(error); if (!data || !data.length) throw notSaved; after(table); },
    async delete(){ const {data, error} = await sb.from(table).delete().eq("id", id).select("id");
      if (error) throw wrap(error); if (!data || !data.length) throw notSaved; after(table); }
  });
  return {
    doc(path){ const [t, id] = path.split("/"); return docRef(t, id); },
    collection(table){ return {
      doc: id => docRef(table, id),
      onSnapshot(fn, onErr){
        const rows = new Map();
        const emit = () => { const docs = [...rows.values()].map(o => ({id:o.id, data:() => o})); fn({docs, size:docs.length, empty:!docs.length}); };
        const load = async () => {
          const {data, error} = await sb.from(table).select("*");
          if (error){ onErr && onErr(wrap(error)); return; }
          rows.clear(); (data||[]).forEach(r => rows.set(r.id, fromRow(table, r))); emit();
        };
        reloads[table] = load;
        // Live updates: other people's changes arrive here without a refresh.
        const ch = sb.channel("rt-" + table)
          .on("postgres_changes", {event:"*", schema:"public", table}, p => {
            if (p.eventType === "DELETE") { if (p.old && p.old.id) rows.delete(p.old.id); }
            else if (p.new && p.new.id) rows.set(p.new.id, fromRow(table, p.new));
            emit();
          })
          .subscribe();
        document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
        load();
        return () => { sb.removeChannel(ch); delete reloads[table]; };
      }
    }; }
  };
}

// "Urgent" was briefly a status; such tasks now read as In Progress + High priority.
function fromDoc(d){
  const t = {...d.data(), id:d.id};
  return t.status === "Urgent" ? {...t, status:"In Progress", priority:"High"} : t;
}

// ---------- boot ----------
refreshPickers();
setView(view);

(async () => {
  const claude = window.claude;
  const cfg = window.SUPABASE_CONFIG || {};
  const cfgOk = cfg.url && cfg.anonKey && !/YOUR[-_]/i.test(cfg.url + cfg.anonKey);
  if ((!claude || !claude.use) && cfgOk && window.supabase && window.supabase.createClient){
    // Supabase mode: shared, live data. No sign-in: anyone who opens the page can view and edit.
    const sb = window.supabase.createClient(cfg.url, cfg.anonKey, {auth:{persistSession:false, autoRefreshToken:false}});
    const db = makeSupabaseDb(sb);
    dbRef = db; window.trackerDb = db;
    canManage = canWrite = true;
    watchSettings(db);
    db.collection("tasks").onSnapshot(snap => {
      tasks = snap.docs.map(d => fromDoc(d));
      loaded = true; refreshPickers(); render();
      if (openId && openId !== "new" && !tasks.find(x=>x.id===openId)) closeSheet();
    }, e => { loaded = true; render(); toast("Couldn't load tasks from Supabase: " + e.message); });
    return;
  }
  if (cfgOk && !window.supabase) console.warn("Supabase library did not load; using browser-only storage.");
  if (!claude || !claude.use){
    // Standalone mode: browser-only storage, full editing for whoever opens the page.
    canManage = true; canWrite = true;
    const db = makeLocalDb({tasks: window.SEED_TASKS || []});
    dbRef = db; window.trackerDb = db;
    watchSettings(db);
    db.collection("tasks").onSnapshot(snap => {
      tasks = snap.docs.map(d => fromDoc(d));
      loaded = true; refreshPickers(); render();
    });
    return;
  }
  const [db, user] = await Promise.all([claude.use("db"), claude.use("user")]);
  if (user){
    canManage = await user.canEdit();
    const w = await user.can("data.write"); if (w === false) canWrite = false;
  }
  if (!db){ loaded = true; canWrite = false; render(); return; }
  dbRef = db;
  watchSettings(db);
  db.collection("tasks").onSnapshot(snap => {
    tasks = snap.docs.map(d => fromDoc(d));
    loaded = true; refreshPickers(); render();
    if (openId && openId !== "new" && !tasks.find(x=>x.id===openId)) closeSheet();
  }, err => { loaded = true; render(); toast("Lost connection to the tracker. Reload to try again."); });
})();
})();