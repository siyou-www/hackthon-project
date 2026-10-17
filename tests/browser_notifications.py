"""Optional production UI smoke checks: pip install playwright; use system Chromium.
Run frontend's npm run preview on port 4173, then python tests/browser_notifications.py.
All permissions, subscriptions and deliveries in these checks are mocked.
"""
import json
from datetime import datetime
from zoneinfo import ZoneInfo
from playwright.sync_api import sync_playwright

ORIGIN = 'http://127.0.0.1:4173'
SETUP = '''({mode}) => {
  window.permissionRequests = 0;
  window.subscriptionsCreated = 0;
  let permission = mode === 'denied' ? 'denied' : 'default';
  if (mode === 'unsupported') {
    delete window.PushManager;
    return;
  }
  Object.defineProperty(window, 'Notification', {value: {
    get permission() {return permission},
    requestPermission: async () => {
      window.permissionRequests++;
      permission = mode === 'deny-click' ? 'denied' : 'granted';
      return permission;
    }
  }});
  let subscription = null;
  const registration = {pushManager: {
    getSubscription: async () => subscription,
    subscribe: async (options) => {
      if (!options.userVisibleOnly || options.applicationServerKey.length !== 65) throw Error('Invalid subscribe options');
      window.subscriptionsCreated++;
      subscription = {toJSON: () => ({endpoint:'https://web.push.apple.com/mock',keys:{p256dh:'mock',auth:'mock'}}), unsubscribe:async () => {subscription=null; return true}};
      return subscription;
    }
  }};
  Object.defineProperty(navigator.serviceWorker, 'ready', {value:Promise.resolve(registration)});
  navigator.serviceWorker.getRegistration = async () => registration;
}'''


def run():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
        for mode in ('unsupported', 'denied', 'deny-click', 'ios-browser', 'success'):
            options = {'user_agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)'} if mode == 'ios-browser' else {}
            context = browser.new_context(**options)
            context.add_init_script(f'({SETUP})({json.dumps({"mode": mode})})')
            requests = []
            now = datetime.now(ZoneInfo('America/Los_Angeles')).strftime('%Y-%m-%dT14:00')
            hour = {'time': now, 'temperature_c': 32, 'temperature_f': 89.6, 'precipitation_probability': 70}
            activity = {'time': now, 'title': 'Basketball', 'outdoor': True}
            def api(route):
                path = route.request.url
                if '/api/weather' in path:
                    data = {'timezone': 'America/Los_Angeles', 'hourly': [hour]}
                elif path.endswith('/reminders'):
                    assert route.request.headers['authorization'] == 'Bearer ' + 't' * 43
                    data = {'reminders': []}
                elif '/api/daily-plan' in path:
                    assert route.request.post_data_json['activities'] == [activity]
                    data = {'activities': [{'activity': activity, 'weather': hour, 'advice': ['Stay hydrated.']}]}
                else:
                    requests.append(route.request)
                    if path.endswith('/public-key'):
                        data = {'public_key': 'B' + 'A' * 86}  # 65-byte key for mocked PushManager
                    elif path.endswith('/test'):
                        assert route.request.headers['authorization'] == 'Bearer ' + 't' * 43
                        data = {'status': 'accepted'}
                    elif route.request.method == 'DELETE':
                        assert route.request.headers['authorization'] == 'Bearer ' + 't' * 43
                        data = {'status': 'unregistered'}
                    else:
                        assert route.request.post_data_json['subscription']['endpoint'] == 'https://web.push.apple.com/mock'
                        data = {'id': 'test-subscription', 'token': 't' * 43}
                route.fulfill(json=data, headers={'Access-Control-Allow-Origin': '*'})
            context.route('**/api/**', api)
            page = context.new_page()
            page.goto(ORIGIN)
            enable = page.get_by_role('button', name='Enable Notifications', exact=True)
            send = page.get_by_role('button', name='Send Test Notification', exact=True)
            assert page.evaluate('window.permissionRequests') == 0
            assert len(requests) == 0
            assert send.is_disabled()
            if mode in ('unsupported', 'denied', 'ios-browser'):
                assert enable.is_disabled()
                expected = {'unsupported': 'does not support Web Push', 'denied': 'Notifications are blocked', 'ios-browser': 'Add to Home Screen'}[mode]
                assert expected in page.locator('section[aria-labelledby="notifications-title"]').inner_text()
            elif mode == 'deny-click':
                enable.click()
                page.get_by_role('alert').wait_for()
                assert page.evaluate('window.permissionRequests') == 1
                assert len(requests) == 0
                assert enable.is_disabled()
            else:
                enable.click()
                page.get_by_text('Notifications enabled.', exact=False).wait_for()
                assert page.evaluate('window.permissionRequests') == 1
                assert page.evaluate('window.subscriptionsCreated') == 1
                assert len(requests) == 2  # No automatic delivery on enable.
                send.click()
                page.get_by_text('Test accepted', exact=False).wait_for()
                assert len(requests) == 3
                page.get_by_role('button', name='Disable Notifications', exact=True).click()
                page.get_by_text('Notifications disabled on this device.', exact=True).wait_for()
                assert page.evaluate("localStorage.getItem('daycast.push.capability.v1')") is None
                assert len(requests) == 4
                # Exercise existing app flows in the same production build.
                page.locator('.weather-card').wait_for()
                page.get_by_role('button', name='Switch to °F').click()
                assert '89.6°F' in page.locator('.weather-card').inner_text()
                page.locator('.weather-card').click()
                page.get_by_placeholder('Activity name (e.g. Basketball)').fill('Basketball')
                page.get_by_label('Outdoor activity').check()
                page.get_by_role('button', name='Save Activity').click()
                page.get_by_role('button', name='Generate My Daily Plan').click()
                page.locator('.plan-card').wait_for()
                assert 'Stay hydrated.' in page.locator('.plan-card').inner_text()
                print('PASS existing weather, unit toggle, activity and Daily Plan UI')
            print('PASS notification UI:', mode)
            context.close()
        browser.close()


if __name__ == '__main__':
    run()
