const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '../static/app.js'), 'utf8');

function setup() {
  const context = vm.createContext({
    console,
    setTimeout,
    clearTimeout,
    window: { addEventListener() {} },
  });
  vm.runInContext(source, context);
  return (code) => vm.runInContext(code, context);
}

test('current focus renders compactly and expands one direction on demand', () => {
  const run = setup();
  const html = run(`
    state.memory = {
      rollups: [
        {rollup_key:'project_progress',title:'项目推进与验证',summary:'项目方向',next_action:'先完成一次小范围验证',reason:'重复出现',proposal_count:20,source_entry_ids:[1,2]},
        {rollup_key:'content_creation',title:'内容与创作流程',summary:'内容方向',next_action:'整理一版草稿',reason:'重复出现',proposal_count:18,source_entry_ids:[3]},
        {rollup_key:'learning_and_review',title:'学习与复盘改进',summary:'学习方向',next_action:'补齐复盘数据',reason:'重复出现',proposal_count:10,source_entry_ids:[4]}
      ],
      active_proposal_count: 48,
      completed_proposal_count: 2,
      digest: {status:'done'}
    };
    renderMemoryPanel();
  `);
  assert.equal((html.match(/class="focus-card /g) || []).length, 3);
  assert.match(html, /当前重点/);
  assert.match(html, /48 条进行中的建议/);
  assert.match(html, /查看相关建议 · 20/);
  assert.match(html, /20 条建议 · 2 条来源/);
  assert.doesNotMatch(html, /先完成一次小范围验证.*接受/);

  const expanded = run(`
    state.memoryDetail = {
      proposals: [
        {id:1,kind:'action',status:'proposed',text:'先完成一次小范围验证',reason:'月报',sources:[{entry_id:1}],rollup_key:'project_progress',events:[]},
        {id:2,kind:'action',status:'done',text:'已完成的旧建议',reason:'旧记录',sources:[{entry_id:2}],rollup_key:'project_progress',events:[]}
      ]
    };
    state.memoryExpandedRollup = 'project_progress';
    renderMemoryPanel();
  `);
  assert.match(expanded, /先完成一次小范围验证/);
  assert.match(expanded, /收起相关建议/);
  assert.doesNotMatch(expanded, /已完成的旧建议/);
});

test('report action candidates stay collapsed by default', () => {
  const run = setup();
  const html = run(`
    renderReportBody({
      action_candidates: [
        {text:'先做一个小规模验证',reason:'已有记录支持',source_entry_ids:[1]}
      ]
    });
  `);
  assert.match(html, /<details class="report-section report-candidates report-actions-fold">/);
  assert.match(html, /待确认行动 · 1/);
});

test('historical suggestions have a lazy detail entry point', () => {
  const run = setup();
  const html = run(`
    state.memory = { rollups: [], proposals: [], completed_proposal_count: 6 };
    state.memoryDetail = null;
    state.memoryExpandedRollup = '';
    renderMemoryPanel();
  `);
  assert.match(html, /已完成与已忽略 · 6/);
  assert.match(html, /展开后读取已完成和已忽略的建议/);
});
