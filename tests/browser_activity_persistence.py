"""Production PWA upgrade regression. Build frontend first; requires Playwright/Chromium.

No real API/backend access: forecast calls are mocked. --previous-dist points to a built historic, memory-only DayCast release.
--dist selects the candidate production build. See docs/activity-persistence.md.
"""
import argparse
from datetime import datetime
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Thread
from zoneinfo import ZoneInfo

from playwright.sync_api import sync_playwright

KEY = 'daycast.activities.v1'
ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dist', type=Path, default=ROOT / 'frontend/dist')
    parser.add_argument('--previous-dist', type=Path, required=True)
    args = parser.parse_args()
    assert (args.dist / 'sw.js').exists(), 'Run npm run build in frontend/ first'
    active = {'directory': args.previous_dist.resolve()}
    class Handler(SimpleHTTPRequestHandler):
        def translate_path(self, path):
            # New handler per request; switch releases without changing origin.
            self.directory = str(active['directory'])
            return super().translate_path(path)

        def end_headers(self):
            self.send_header('Cache-Control', 'no-cache')
            super().end_headers()

        def log_message(self, *args):
            pass
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    thread = Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path='/usr/bin/chromium', headless=True, args=['--no-sandbox'])
            context = browser.new_context()
            day = datetime.now(ZoneInfo('America/Los_Angeles')).strftime('%Y-%m-%d')
            hour = f'{day}T14:00'
            def weather(route):
                assert '/api/weather' in route.request.url, 'Unexpected API request in persistence test'
                route.fulfill(json={'timezone': 'America/Los_Angeles', 'hourly': [
                    {'time': hour, 'temperature_c': 20, 'temperature_f': 68, 'precipitation_probability': 10}]})
            context.route('**/api/**', weather)
            page = context.new_page()
            origin = f'http://127.0.0.1:{server.server_port}'
            page.goto(origin)
            page.evaluate('navigator.serviceWorker.ready')
            page.reload()
            page.wait_for_function('navigator.serviceWorker.controller !== null')
            page.locator('.weather-card').click()
            page.get_by_placeholder('Activity name (e.g. Basketball)').fill('Memory-only activity')
            page.get_by_role('button', name='Save Activity', exact=True).click()
            assert page.evaluate(f'localStorage.getItem("{KEY}")') is None
            page.reload()
            assert 'Memory-only activity' not in page.locator('.weather-card').inner_text()
            print('PASS old shell reproduces missing storage key and activity loss on refresh')
            # An update must not force-reload the running activity editor.
            page.locator('.weather-card').click()
            page.get_by_placeholder('Activity name (e.g. Basketball)').fill('Unsaved draft during update')
            page.evaluate('''() => {
                window.controllerChanges=0;
                navigator.serviceWorker.addEventListener('controllerchange',()=>window.controllerChanges++);
            }''')
            active['directory'] = args.dist.resolve()
            page.evaluate('navigator.serviceWorker.getRegistration().then(r=>r.update())')
            page.wait_for_function('window.controllerChanges > 0', timeout=15000)
            assert page.get_by_placeholder('Activity name (e.g. Basketball)').input_value() == 'Unsaved draft during update'
            print('PASS new worker activates while preserving the current unsaved editor (no forced reload)')
            page.reload()
            page.locator('.weather-card').wait_for()
            page.locator('.weather-card').click()
            page.get_by_placeholder('Activity name (e.g. Basketball)').fill('Persisted activity')
            page.get_by_role('button', name='Save Activity', exact=True).click()
            page.get_by_text('Activity saved without a reminder.', exact=True).wait_for()
            activity = page.evaluate(f'JSON.parse(localStorage.getItem("{KEY}"))["{hour}"]')
            assert activity['name'] == 'Persisted activity'
            assert activity['id']
            page.reload()
            page.get_by_role('button', name='2:00 PM', exact=False).wait_for()
            assert 'Persisted activity' in page.locator('.weather-card').inner_text()
            restored = page.evaluate(f'JSON.parse(localStorage.getItem("{KEY}"))["{hour}"]')
            assert restored == activity
            print('PASS refreshed client writes localStorage and preserves activity/UUID across another real reload')
            browser.close()
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
