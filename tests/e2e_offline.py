# ঐচ্ছিক ব্রাউজার টেস্ট (Playwright লাগে): node build.mjs && node tests/dev-server.js  চালু রেখে  python3 tests/e2e_offline.py
import json, urllib.request, time
from playwright.sync_api import sync_playwright
BASE='http://localhost:8123'
errors=[]
def state():
    return json.load(urllib.request.urlopen(BASE+'/__state'))['tables']
with sync_playwright() as p:
    b=p.chromium.launch(executable_path='/opt/pw-browsers/chromium-1194/chrome-linux/chrome',args=['--no-sandbox'])
    ctx=b.new_context(viewport={'width':1280,'height':860})
    page=ctx.new_page()
    page.on('pageerror',lambda e:errors.append('PAGEERROR '+str(e)))
    page.on('console',lambda m:errors.append('CONSOLE '+m.text[:160]) if m.type=='error' and 'fonts' not in m.text and 'ERR_' not in m.text and 'Failed to load resource' not in m.text else None)
    page.goto(BASE+'/'); page.wait_for_selector('.setup',timeout=15000)
    print('1 setup screen shown:', page.inner_text('.setup h1'))
    page.screenshot(path='/tmp/o1_setup.png')
    # wrong key first
    page.fill('#setupForm [name=url]',BASE+'/exec'); page.fill('#setupForm [name=key]','wrong'); page.click('#setupForm [type=submit]'); page.wait_for_selector('.toast.err')
    print('2 wrong key ->', page.locator('.toast.err').last.inner_text())
    page.fill('#setupForm [name=key]','test-key'); page.click('#setupForm [type=submit]')
    page.wait_for_selector('.hero-num',timeout=20000)
    print('3 connected; products downloaded:', page.evaluate("Engine.call('getProducts',[]).then(r=>r.data.length)"))
    page.wait_for_function("document.querySelector('.sidebar .sync-txt').textContent.includes('সিঙ্ক হয়েছে')")
    print('4 pill:', page.inner_text('.sidebar .sync-txt'))
    page.evaluate("navigator.serviceWorker.ready.then(()=>true)"); page.wait_for_timeout(1500)
    print('5 sw controlling:', page.evaluate("!!navigator.serviceWorker.controller || navigator.serviceWorker.ready.then(r=>!!r.active)"))
    page.reload(); page.wait_for_selector('.hero-num'); page.wait_for_timeout(500)
    print('  controlled after reload:', page.evaluate("!!navigator.serviceWorker.controller"))

    # ---------------- OFFLINE ----------------
    ctx.set_offline(True); page.wait_for_timeout(400)
    print('6 offline pill:', page.inner_text('.sidebar .sync-txt'))
    salesBefore=len(state()['Sales'])
    # sell
    page.click('.nav-item[data-p=pos]'); page.click('.tile >> nth=0'); page.click('.tile >> nth=1')
    page.click('#sellBtn'); page.wait_for_selector('.receipt'); print('7 offline sale receipt total:', page.inner_text('.rc-tot .g')); page.keyboard.press('Escape')
    # new product
    page.click('.nav-item[data-p=newproduct]')
    page.fill('#pf [name=name]','অফলাইন-ঘড়ি'); page.fill('#pf [name=purchase]','100'); page.fill('#pf [name=price]','170'); page.fill('#pf [name=stock]','6')
    page.click('[type=submit][form=pf]'); page.wait_for_selector('.toast.in')
    # expense + saving
    page.click('.nav-item[data-p=expense]'); page.fill('#ef [name=category]','ভাড়া'); page.fill('#ef [name=amount]','250'); page.click('#ef [type=submit]'); page.wait_for_selector('#expRes .tbl')
    page.click('.nav-item[data-p=savings]'); page.fill('#vf [name=amount]','100'); page.click('#vf [type=submit]'); page.wait_for_selector('#savRes .tbl')
    print('8 pill after offline work:', page.inner_text('.sidebar .sync-txt'))
    page.click('.sidebar .sync-btn'); page.wait_for_selector('#syncBody'); page.screenshot(path='/tmp/o2_panel_offline.png'); page.keyboard.press('Escape')
    print('9 server unchanged while offline:', len(state()['Sales'])==salesBefore)

    # reload the app OFFLINE (service worker + IndexedDB)
    page.reload(); page.wait_for_selector('.hero-num',timeout=15000)
    print('10 reloaded offline OK; hero today sales:', page.inner_text('.hero-num'), '| pill:', page.inner_text('.sidebar .sync-txt'))
    page.click('.nav-item[data-p=products]'); page.fill('#plq','অফলাইন'); page.wait_for_timeout(300); print('    offline product visible:', page.inner_text('#plCount'))
    page.screenshot(path='/tmp/o3_offline_products.png')

    # ---------------- BACK ONLINE ----------------
    ctx.set_offline(False)
    page.wait_for_function("document.querySelector('.sidebar .sync-txt').textContent.includes('সিঙ্ক হয়েছে')",timeout=30000)
    print('11 auto-synced; pill:', page.inner_text('.sidebar .sync-txt'))
    s=state()
    print('12 server now has: sales rows', len(s['Sales'])-1, '| expense rows', len(s['Expenses'])-1, '| savings', len(s['Savings'])-1, '| new product:', any(r[1]=='অফলাইন-ঘড়ি' for r in s['Products']))
    print('    sale timestamp kept:', s['Sales'][-1][1])
    page.click('.nav-item[data-p=settings]'); page.wait_for_selector('#reconn'); page.screenshot(path='/tmp/o4_settings.png',full_page=True)

    # second device sees the data
    ctx2=b.new_context(viewport={'width':390,'height':780},is_mobile=True,has_touch=True); m=ctx2.new_page()
    m.on('pageerror',lambda e:errors.append('M PAGEERROR '+str(e)))
    m.goto(BASE+'/'); m.wait_for_selector('.setup'); m.fill('#setupForm [name=url]',BASE+'/exec'); m.fill('#setupForm [name=key]','test-key'); m.click('#setupForm [type=submit]'); m.wait_for_selector('.hero-num',timeout=20000)
    print('13 device B products include offline one:', m.evaluate("Engine.call('getProducts',[]).then(r=>r.data.some(p=>p.name==='অফলাইন-ঘড়ি'))"))
    m.screenshot(path='/tmp/o5_mobile.png')
    b.close()
print('ERRORS:', errors or 'none')
