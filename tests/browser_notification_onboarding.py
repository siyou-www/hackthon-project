"""Production dialog smoke test. Start Vite preview; all push/API calls are mocked.
Run: python tests/browser_notification_onboarding.py --origin http://127.0.0.1:4173
Requires Python Playwright and system Chromium.
"""
import argparse
from browser_notifications import SETUP
from playwright.sync_api import sync_playwright
import json
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--origin', default='http://127.0.0.1:4173')
origin = parser.parse_args().origin
with sync_playwright() as p:
    browser=p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
    for mode in ['success', 'deny-click', 'unsupported', 'denied', 'ios-browser', 'ios-installed', 'dismiss']:
        ios=mode.startswith('ios')
        context=browser.new_context(**({'user_agent':'iPhone'} if ios else {}))
        context.add_init_script(f'({SETUP})({json.dumps({"mode":mode})})')
        if mode=='ios-installed':
            context.add_init_script("Object.defineProperty(navigator,'standalone',{value:true})")
        def api(route):
            url=route.request.url
            if '/api/weather' in url: data={'timezone':'America/Los_Angeles','hourly':[]}
            elif '/public-key' in url: data={'public_key':'B'+'A'*86}
            else: data={'id':'mock','token':'test-only-capability'}
            route.fulfill(json=data)
        context.route('**/api/**',api)
        page=context.new_page(); page.goto(origin)
        page.get_by_role('heading',name='Notifications',exact=True).wait_for()
        prompt=page.get_by_role('dialog')
        if mode in ['unsupported','denied','ios-browser']:
            page.wait_for_timeout(200)
            assert prompt.count()==0
        else:
            prompt.wait_for()
            assert page.evaluate('window.permissionRequests')==0
            assert page.evaluate("document.activeElement.textContent")=='Not Now'
            # Check native keyboard navigation between the dialog actions.
            page.keyboard.press('Shift+Tab')
            assert page.evaluate("document.activeElement.textContent").strip()=='Enable Notifications'
            if mode in ['dismiss','ios-installed']:
                page.keyboard.press('Escape')
                assert prompt.count()==0
                page.reload(); page.wait_for_timeout(200)
                assert prompt.count()==0
                assert page.evaluate("localStorage.getItem('skycue.notifications.onboarding.v1')")=='seen'
            else:
                prompt.get_by_role('button',name='Enable Notifications').click()
                if mode=='success':
                    page.get_by_text('Notifications enabled.',exact=False).wait_for()
                    assert prompt.count()==0
                else:
                    prompt.get_by_role('alert').wait_for()
                    prompt.get_by_role('button',name='Not Now').click()
                    assert prompt.count()==0
                assert page.evaluate('window.permissionRequests')==1
        print('PASS native dialog:',mode)
        context.close()
    browser.close()
