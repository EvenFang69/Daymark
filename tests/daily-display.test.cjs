const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
test('ten submissions display one daily report and collapsed original evidence', () => {
  const context = vm.createContext({window:{addEventListener(){}}, console});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/app.js'),'utf8'), context);
  const html = vm.runInContext(`
    renderReport = () => '<article class="report">Merged daily log</article>';
    const entries = Array.from({length:10}, (_,i)=>({id:i+1,raw_text:'Original '+i,created_at:'2026-09-11T10:00:00Z',status:'archived',ai_state:'ready',attachments:[]}));
    renderDayContent('2026-09-11',entries,{status:'ready'});
  `, context);
  assert.equal((html.match(/class="report"/g)||[]).length,1);
  assert.equal((html.match(/class="day-original"/g)||[]).length,10);
  assert.ok(!html.includes('class="entry-card'));
  assert.match(html, /<details class="day-evidence" data-key="evidence-2026-09-11">/);
  assert.match(html, /Original 9/);
});
