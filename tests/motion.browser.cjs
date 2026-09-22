// Runs against a temporary database. It never writes to the personal journal.
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

(async () => {
  const root = path.resolve(__dirname, '..');
  const fixture = spawn('python3', ['-u', 'tests/serve_ui.py'], { cwd: root });
  let browser;
  try {
    await new Promise((resolve, reject) => {
      fixture.stdout.on('data', data => { if (String(data).includes('Isolated UI')) resolve(); });
      fixture.on('exit', code => reject(new Error('Fixture failed: ' + code)));
      fixture.stderr.on('data', data => process.stderr.write(data));
    });
    browser = await chromium.launch({headless:true});
    fs.mkdirSync(path.join(root, 'outputs', 'qa'), {recursive:true});
    for (const width of [1280, 720, 390]) {
      const context = await browser.newContext({viewport:{width,height:900}, reducedMotion:'no-preference'});
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto('http://127.0.0.1:8766/');
      await page.locator('#composer-input').waitFor();
      await page.locator('#composer-input').fill('Draft stays during the transition');
      await page.evaluate(() => {
        window.__input = document.querySelector('#composer-input');
        window.__samples = [];
        document.addEventListener('click', () => {
          const started = performance.now();
          const sample = () => {
            window.__samples.push({t:performance.now()-started, color:getComputedStyle(document.body).backgroundColor,
              theme:document.documentElement.dataset.theme, transition:document.documentElement.className});
            if (performance.now()-started < 950) requestAnimationFrame(sample);
          };
          sample();
        }, {capture:true,once:true});
      });
      await page.locator('[data-action="toggle-appearance"]').click();
      await page.waitForTimeout(1000);
      const result = await page.evaluate(() => ({
        colors: new Set(window.__samples.map(s=>s.color)).size,
        preserved:window.__input === document.querySelector('#composer-input'),
        value:document.querySelector('#composer-input').value,
        theme:document.documentElement.dataset.theme,
        horizontalOverflow:document.documentElement.scrollWidth > innerWidth,
        buttonSize:document.querySelector('.appearance-toggle').getBoundingClientRect().width,
        first:window.__samples[0], last:window.__samples.at(-1),
      }));
      assert.ok(result.colors > 8, 'Theme must interpolate, not jump: ' + JSON.stringify(result));
      assert.ok(result.preserved);
      assert.equal(result.value, 'Draft stays during the transition');
      assert.equal(result.horizontalOverflow, false);
      if (width < 720) assert.ok(result.buttonSize >= 44);
      await page.getByRole('button', {name:'设置',exact:true}).click();
      await page.waitForTimeout(520);
      const modalBounds = await page.locator('.settings-modal').boundingBox();
      assert.ok(modalBounds.x >= 0 && modalBounds.x + modalBounds.width <= width + 1);
      await page.locator('select[name="appearance_mode"]').selectOption('dark');
      await page.getByRole('button', {name:'保存设置'}).click();
      await page.locator('.settings-modal').waitFor({state:'detached'});
      await page.waitForTimeout(850);
      await page.screenshot({path:path.join(root,'outputs','qa',`record-dark-${width}.png`)});
      await page.locator('.desktop-nav:visible [data-page="review"], .bottom-nav:visible [data-page="review"]').click();
      await page.waitForTimeout(750);
      const todayColors = await page.locator('.is-today .calendar-day-number').evaluate(el => {
        const style=getComputedStyle(el); return [style.color,style.backgroundColor];
      });
      assert.notEqual(todayColors[0],todayColors[1]);
      await page.screenshot({path:path.join(root,'outputs','qa',`calendar-dark-${width}.png`)});
      await page.emulateMedia({reducedMotion:'reduce'});
      await page.locator('[data-action="toggle-appearance"]').click();
      const reduced = await page.evaluate(() => document.documentElement.classList.contains('theme-transition'));
      assert.equal(reduced, false, 'Reduced motion disables theme interpolation');
      assert.deepEqual(errors, []);
      console.log('PASS browser width=' + width + ' color samples=' + result.colors + ' reduced-motion=true draft-preserved=true');
      await context.close();
    }
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:8766/__tests__/dom');
    const domResult = await page.locator('#results').innerText();
    assert.doesNotMatch(domResult, /FAIL|ERROR/);
    console.log(domResult);
  } finally {
    if (browser) await browser.close();
    fixture.kill('SIGINT');
    if (fixture.exitCode === null) await once(fixture, 'exit');
  }
})().catch(error => { console.error(error); process.exitCode=1; });
