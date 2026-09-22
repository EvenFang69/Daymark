const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');

function setup() {
  const handlers = {}, pending = [];
  const root = { dataset: {}, addEventListener: (name, fn) => { handlers[name] = fn; } };
  const context = vm.createContext({
    setTimeout, clearTimeout, console, AbortController,
    window: { addEventListener() {}, scrollTo() {}, scrollY: 0 },
    history: { pushState() {}, replaceState() {} },
    matchMedia: () => ({ matches: true }),
    document: { querySelector: (selector) => selector === '#app' ? root : null },
    request: (url) => new Promise((resolve, reject) => pending.push({ url, resolve, reject })),
  });
  vm.runInContext(source + `
    api = request;
    render = () => {};
    updateOverlays = () => {};
    state.session = {business_date:'2026-09-08'};
    state.page = 'review'; state.reviewView = 'day';
    state.calendarCursor = '2026-09-08'; state.calendarSelectedDate = '2026-09-08';
  `, context);
  const run = (code) => vm.runInContext(code, context);
  function finish(list, marker) {
    for (const item of list) {
      if (item.url.startsWith('/api/calendar')) item.resolve({ days: [{ date: marker }] });
      else if (item.url.startsWith('/api/timeline')) item.resolve({ date: marker, entries: [{ id: marker }] });
      else item.resolve({ report: { status: 'ready', title: marker } });
    }
  }
  return { run, pending, finish, context, handlers };
}

test('late day responses cannot overwrite a newer selection', async () => {
  const t = setup();
  const old = t.run('loadReviewData()');
  const oldRequests = t.pending.splice(0);
  const next = t.run("state.calendarSelectedDate='2026-09-10'; navigationRevision++; loadReviewData()");
  t.finish(t.pending.splice(0), '2026-09-10');
  await next;
  t.finish(oldRequests, '2026-09-08');
  await old;
  assert.equal(t.run('state.reviewEntries[0].id'), '2026-09-10');
  assert.equal(t.run('state.reviewReport.title'), '2026-09-10');
  assert.equal(t.run('state.calendarSelectedDate'), '2026-09-10');
});

test('navigation away suppresses old errors and rendering', async () => {
  const t = setup();
  const old = t.run('loadReviewData()');
  t.run("state.page='record'; navigationRevision++; let renders=0; render=()=>renders++");
  for (const item of t.pending) item.reject(new Error('old failure'));
  await old;
  assert.equal(t.run('renders'), 0);
  assert.equal(t.run('state.reviewError'), '');
});

test('timeline date and records belong to the latest request', async () => {
  const t = setup();
  const old = t.run("state.page='timeline'; state.timelineDate='2026-09-08'; loadTimeline()");
  const oldRequests = t.pending.splice(0);
  const next = t.run("state.timelineDate='2026-09-09'; navigationRevision++; loadTimeline()");
  t.finish(t.pending.splice(0), '2026-09-09');
  await next;
  t.finish(oldRequests, '2026-09-08');
  await old;
  assert.equal(t.run('state.timelineDate'), '2026-09-09');
  assert.equal(t.run('state.timelineEntries[0].id'), '2026-09-09');
});

test('report polling stops after navigation even if a response is in flight', async () => {
  const t = setup();
  t.run('sleep=async()=>{}');
  const polling = t.run("watchReport('daily','2026-09-08')");
  await Promise.resolve();
  assert.equal(t.pending.length, 1);
  t.run("state.page='record'; navigationRevision++; state.reviewReport=null");
  t.finish(t.pending.splice(0), 'old report');
  await polling;
  assert.equal(t.run('state.reviewReport'), null);
  assert.equal(t.run('reportPolls.size'), 0);
});

test('closing a loading detail cannot reopen or reanimate it', async () => {
  const t = setup();
  t.run("showOverlay=(patch)=>Object.assign(state,patch); let updates=0; updateOverlays=()=>updates++");
  const detail = t.run('openDetail(7)');
  t.run('state.detailEntryId=null');
  t.pending[0].resolve({ entry: { id: 7 } });
  await detail;
  assert.equal(t.run('state.detailEntryId'), null);
  assert.equal(t.run('updates'), 0);
});

test('slow reports keep polling without repeatedly rendering unchanged content', async () => {
  const t = setup();
  t.run(`let polls=0, renders=0; sleep=async()=>{}; render=()=>renders++;
    api=async()=>({report:{status:++polls>40?'ready':'processing',title:'Report'}});`);
  await t.run("watchReport('daily','2026-09-08')");
  assert.equal(t.run('polls'), 41);
  assert.equal(t.run('renders'), 2);
  assert.equal(t.run('state.reviewReport.status'), 'ready');
  assert.equal(t.run('reportPolls.size'), 0);
});

test('vertical and diagonal scrolling never flip dates; horizontal swipe fires once', () => {
  const t = setup();
  t.run('let flips=[]; shiftCalendar=(step)=>flips.push(step); bindApp()');
  const surface = { isConnected: true };
  const target = { closest: () => surface };
  const touch = (x, y) => ({ clientX: x, clientY: y, identifier: 1 });
  function drag(x, y) {
    t.handlers.touchstart({ target, touches: [touch(200, 200)] });
    t.handlers.touchmove({ touches: [touch(x, y)] });
    t.handlers.touchend({ target, changedTouches: [touch(x, y)] });
  }
  drag(120, 320);
  drag(120, 260);
  assert.equal(t.run('flips.length'), 0);
  drag(80, 202);
  assert.equal(t.run('flips.join()'), '1');
  t.handlers.touchend({ target, changedTouches: [touch(80, 202)] });
  assert.equal(t.run('flips.length'), 1);
  let prevented = false;
  t.handlers.click({ target, preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
});

test('a new date has a loading state, never the previous day under a new title', () => {
  const t = setup();
  t.run("state.reviewDataKey=reviewKey(); state.reviewEntries=[{id:'old'}]; state.calendarSelectedDate='2026-09-09'; loadReviewData()");
  assert.equal(t.run('state.calendarLoading'), true);
  assert.equal(t.run('state.reviewEntries.length'), 0);
  assert.equal(t.run('state.reviewReport'), null);
});

test('calendar title is not a hidden today button and raw controls work outside the feed', () => {
  const t = setup();
  assert.match(t.run('renderReview()'), /<h2 class="calendar-title">/);
  assert.match(t.run('renderReview()'), /返回月视图/);
  assert.match(t.run("renderEntryCard({id:1, raw_text:'original', created_at:'2026-09-08', record_date:'2026-09-08'})"), /raw-reveal/);
});

test('double closing an overlay goes back only once', () => {
  const t = setup();
  let backs = 0;
  t.context.history.state = {overlay:true};
  t.context.history.back = () => backs++;
  t.run('closeOverlay(); closeOverlay()');
  assert.equal(backs, 1);
});

test('reduced motion skips transitions', () => {
  const t = setup();
  let animated = 0;
  t.context.surface = {animate() { animated++; }};
  t.run('animateSurface(surface)');
  assert.equal(animated, 0);
});

test('collapsed records do not eagerly build long original-text DOM', () => {
  const t = setup();
  assert.equal(t.run("renderRawEvidence({id:1,raw_text:'Original'})"), '');
  assert.match(t.run("state.rawOpen[1]=true; renderRawEvidence({id:1,raw_text:'Original'})"), /Original/);
});

test('report evidence stays compact while retaining the source target', () => {
  const t = setup();
  const html = t.run("sourceButtons([{entry_id:7,analysis_version:1}])");
  assert.match(html, />#7</);
  assert.doesNotMatch(html, /来源 7|· v1/);
  assert.match(html, /查看原始记录 7，AI 第 1 版/);
  assert.match(html, /data-action="source-entry"/);
});

test('automatic appearance follows the configured night interval', () => {
  const t = setup();
  assert.equal(t.run("appearanceForMinutes({appearance_mode:'auto',dark_mode_start:'20:00',light_mode_start:'07:00'}, 19 * 60 + 59)"), 'light');
  assert.equal(t.run("appearanceForMinutes({appearance_mode:'auto',dark_mode_start:'20:00',light_mode_start:'07:00'}, 20 * 60)"), 'dark');
  assert.equal(t.run("appearanceForMinutes({appearance_mode:'auto',dark_mode_start:'20:00',light_mode_start:'07:00'}, 6 * 60 + 59)"), 'dark');
  assert.equal(t.run("appearanceForMinutes({appearance_mode:'auto',dark_mode_start:'20:00',light_mode_start:'07:00'}, 7 * 60)"), 'light');
  assert.equal(t.run("appearanceForMinutes({appearance_mode:'light'}, 23 * 60)"), 'light');
  assert.equal(t.run("appearanceForMinutes({appearance_mode:'dark'}, 10 * 60)"), 'dark');
});

test('the top appearance button offers the opposite fixed mode', () => {
  const t = setup();
  assert.match(t.run("appearanceToggleMarkup({appearance_mode:'light'})"), /切换为深色/);
  assert.match(t.run("appearanceToggleMarkup({appearance_mode:'dark'})"), /切换为浅色/);
});

test('failed AI entries never keep their processing message or shimmer', () => {
  const t = setup();
  const html = t.run("renderEntryCard({id:7,ai_state:'failed',status:'recorded',ai_error:'api_timeout',messages:[{role:'assistant',kind:'processing',content:'正在理解'}]})");
  assert.match(html, /AI 服务响应超时/);
  assert.doesNotMatch(html, /is-shimmer|is-pulsing|正在理解/);
});

test('automatic retry is distinct from terminal failure', () => {
  const t = setup();
  const html = t.run("renderEntryCard({id:7,ai_state:'retrying',status:'recorded',ai_error:'rate_limit_exceeded'})");
  assert.match(html, /等待自动重试/);
  assert.match(html, /中转服务正在限流/);
  assert.doesNotMatch(html, /data-action="retry"|is-shimmer/);
});

test('entry polling continues beyond the old 32-attempt cutoff and stops on completion', async () => {
  const t = setup();
  t.run(`let polls=0; sleep=async()=>{}; patchEntryCard=()=>{}; loadEntries=async()=>{};
    api=async()=>({entry:{id:7,ai_state:++polls>40?'ready':polls===3?'retrying':'processing'}});
    state.page='record';`);
  await t.run('watchEntry(7)');
  assert.equal(t.run('polls'), 41);
  assert.equal(t.run('state.entries[0].ai_state'), 'ready');
  assert.equal(t.run('state.polling[7]'), undefined);
});

test('surface animation has a perceptible deceleration instead of a 200ms flash', () => {
  const t = setup();
  let options;
  t.context.matchMedia = () => ({matches:false});
  t.context.surface = {animate(frames, config) { options=config; return {cancel(){}}; }};
  t.run('animateSurface(surface,1)');
  assert.equal(options.duration, 440);
  assert.equal(options.easing, 'cubic-bezier(.22,1,.36,1)');
});
