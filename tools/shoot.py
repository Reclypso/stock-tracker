"""Screenshot + console-error harness for the leads page (local only).

Usage: python3 tools/shoot.py [scenario ...]
Scenarios: real, filter, mobile-filter, desktop, why, mobile, empty, intro, reduced, blocked, nolibs, modal, mobile-modal
Writes PNGs to tools/v2-shots/ and prints every console message / page error.
"""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright

BASE = "http://localhost:8932"
OUT = Path(__file__).resolve().parent / "v2-shots"
OUT.mkdir(exist_ok=True)
ARGS = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"]
problems = []


def attach(page, name):
    def on_console(msg):
        # Requests the scenario aborts on purpose (CDN/vendor blocking) surface
        # as browser network errors; those are expected, not code errors.
        expected = name in ("blocked", "nolibs") and "net::ERR_FAILED" in msg.text
        if msg.type in ("error", "warning") and not expected:
            problems.append(f"[{name}] console.{msg.type}: {msg.text}")
        print(f"  [{name}] console.{msg.type}: {msg.text}")
    page.on("console", on_console)
    page.on("pageerror", lambda err: (problems.append(f"[{name}] pageerror: {err}"), print(f"  [{name}] PAGEERROR {err}")))
    page.on("requestfailed", lambda req: print(f"  [{name}] requestfailed {req.url[:100]} {req.failure}"))


def new_page(browser, name, mobile=False, reduced=False, block=None):
    opts = dict(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True) if mobile \
        else dict(viewport={"width": 1440, "height": 900})
    if reduced:
        opts["reduced_motion"] = "reduce"
    ctx = browser.new_context(**opts)
    page = ctx.new_page()
    attach(page, name)
    if block:
        page.route(block, lambda route: route.abort())
    return ctx, page


def scroll_through(page):
    page.evaluate("""async () => { for (let y = 0; y < document.body.scrollHeight; y += 400) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); } }""")
    page.wait_for_timeout(1500)
    page.evaluate("window.scrollTo(0, 0)")
    page.wait_for_timeout(400)


EMPTY_PICKS = '{"picks": []}'
EMPTY_PRICES = '{"prices": {}, "updated": null}'


def serve_empty(page):
    page.route("**/data/picks.json*", lambda r: r.fulfill(status=200, content_type="application/json", body=EMPTY_PICKS))
    page.route("**/data/prices.json*", lambda r: r.fulfill(status=200, content_type="application/json", body=EMPTY_PRICES))


def webgl_state(page):
    return page.evaluate("""() => ({
      webgl: document.getElementById('bg')?.classList.contains('is-on'),
      noWebgl: document.documentElement.classList.contains('no-webgl'),
      gsap: !!window.gsap, cards: document.querySelectorAll('.lead').length,
      overflowX: document.documentElement.scrollWidth - window.innerWidth,
    })""")


def run(name, browser):
    if name == "desktop":
        ctx, page = new_page(browser, name)
        page.goto(f"{BASE}/?demo=1")
        page.wait_for_timeout(4200)
        print("  state", webgl_state(page))
        page.screenshot(path=str(OUT / "desktop-demo.png"))
        scroll_through(page)
        page.screenshot(path=str(OUT / "desktop-demo-full.png"), full_page=True)
        ctx.close()
    elif name == "why":
        ctx, page = new_page(browser, name)
        page.goto(f"{BASE}/?demo=1")
        page.wait_for_timeout(3500)
        summ = page.locator(".block-active details.why > summary").first
        summ.scroll_into_view_if_needed()
        summ.click()
        page.wait_for_timeout(1200)
        lead = page.locator(".block-active .lead:has(details.why[open])").first
        page.evaluate("document.querySelector('.topbar').style.visibility='hidden'")
        lead.screenshot(path=str(OUT / "desktop-why-card.png"))
        page.evaluate("document.querySelector('.topbar').style.visibility=''")
        page.screenshot(path=str(OUT / "desktop-why.png"))
        ctx.close()
    elif name == "mobile":
        ctx, page = new_page(browser, name, mobile=True)
        page.goto(f"{BASE}/?demo=1")
        page.wait_for_timeout(4200)
        print("  state", webgl_state(page))
        page.screenshot(path=str(OUT / "mobile-demo.png"))
        for i, y in enumerate((760, 1500, 2300, 3100)):
            page.evaluate(f"window.scrollTo(0, {y})")
            page.wait_for_timeout(900)
            page.screenshot(path=str(OUT / f"mobile-demo-{i + 1}.png"))
        small = page.evaluate("""() => [...document.querySelectorAll('button, summary, a, select')].filter(e => e.getClientRects().length).map(e => {const r=e.getBoundingClientRect(); return [e.className||e.tagName, Math.round(r.width), Math.round(r.height)]}).filter(([,w,h]) => h < 44 || w < 44)""")
        print("  small tap targets", small)
        ctx.close()
    elif name == "empty":
        for mobile in (False, True):
            ctx, page = new_page(browser, name, mobile=mobile)
            serve_empty(page)
            page.goto(f"{BASE}/")
            page.wait_for_timeout(4000)
            print("  state", webgl_state(page))
            page.screenshot(path=str(OUT / f"empty-{'mobile' if mobile else 'desktop'}.png"))
            page.evaluate("window.scrollTo(0, 700)" if mobile else "window.scrollTo(0, 500)")
            page.wait_for_timeout(700)
            page.screenshot(path=str(OUT / f"empty-{'mobile' if mobile else 'desktop'}-2.png"))
            ctx.close()
    elif name in ("filter", "mobile-filter"):
        mobile = name == "mobile-filter"
        ctx, page = new_page(browser, name, mobile=mobile)
        page.goto(f"{BASE}/?demo=1")
        page.wait_for_timeout(4000)
        page.evaluate("window.scrollTo(0, document.querySelector('.seg').getBoundingClientRect().top + scrollY - 170)")
        page.locator('.seg-btn[data-filter="fast"]').click()
        page.wait_for_timeout(3500)
        print("  fast filter cards:", page.locator(".block-active .lead:not([data-leaving])").count(), "stored:", page.evaluate("localStorage.getItem('stock-tracker:horizon-filter')"))
        page.screenshot(path=str(OUT / f"{name}-fast.png"))
        page.locator('.seg-btn[data-filter="swing"]').click()
        page.wait_for_timeout(3500)
        print("  swing filter cards:", page.locator(".block-active .lead:not([data-leaving])").count(), "in DOM:", page.locator(".block-active .lead").count())
        page.screenshot(path=str(OUT / f"{name}-swing.png"))
        page.reload()
        page.wait_for_timeout(3000)
        print("  after reload filter:", page.evaluate("document.querySelector('.seg-btn.active').dataset.filter"))
        ctx.close()
        # Designed empty-filter state: no fast movers in the feed, Fast filter saved.
        ctx, page = new_page(browser, name, mobile=mobile)
        import json as _json
        demo = _json.loads((Path(__file__).resolve().parent.parent / "demo" / "picks.json").read_text())
        demo["picks"] = [x for x in demo["picks"] if x.get("horizon") != "fast" and not str(x.get("thesis", "")).lower().startswith("fast mover:")]
        page.route("**/demo/picks.json*", lambda r: r.fulfill(status=200, content_type="application/json", body=_json.dumps(demo)))
        page.add_init_script("localStorage.setItem('stock-tracker:horizon-filter', 'fast')")
        page.goto(f"{BASE}/?demo=1")
        page.wait_for_timeout(3500)
        page.evaluate("window.scrollTo(0, document.querySelector('.seg').getBoundingClientRect().top + scrollY - 170)")
        page.wait_for_timeout(900)
        page.screenshot(path=str(OUT / f"{name}-empty.png"))
        ctx.close()
    elif name == "real":
        ctx, page = new_page(browser, name)
        page.goto(f"{BASE}/")
        page.wait_for_timeout(4000)
        print("  state", webgl_state(page))
        page.screenshot(path=str(OUT / "real-data-desktop.png"))
        ctx.close()
    elif name == "intro":
        ctx, page = new_page(browser, name)
        page.goto(f"{BASE}/?demo=1", wait_until="commit")
        t = 0
        for at in (300, 900, 1600, 2400):
            page.wait_for_timeout(at - t)
            t = at
            page.screenshot(path=str(OUT / f"intro-{at}ms.png"))
        ctx.close()
    elif name == "reduced":
        for mobile in (False, True):
            ctx, page = new_page(browser, name, mobile=mobile, reduced=True)
            page.goto(f"{BASE}/?demo=1")
            page.wait_for_timeout(1500)
            print("  state", webgl_state(page))
            page.screenshot(path=str(OUT / f"reduced-{'mobile' if mobile else 'desktop'}.png"))
            ctx.close()
    elif name == "blocked":
        # Every non-localhost request fails (fonts, any CDN).
        ctx, page = new_page(browser, name, block=lambda url: not url.startswith(BASE))
        page.goto(f"{BASE}/?demo=1")
        page.wait_for_timeout(3500)
        print("  state", webgl_state(page))
        page.screenshot(path=str(OUT / "blocked-cdn.png"))
        ctx.close()
    elif name == "nolibs":
        # Vendored GSAP missing too, plus no WebGL.
        ctx, page = new_page(browser, name, block=lambda url: "/vendor/" in url or not url.startswith(BASE))
        page.add_init_script("HTMLCanvasElement.prototype.getContext = function(){ return null; };")
        page.goto(f"{BASE}/?demo=1")
        page.wait_for_timeout(3000)
        print("  state", webgl_state(page))
        page.screenshot(path=str(OUT / "no-libs-no-webgl.png"))
        ctx.close()
    elif name in ("modal", "mobile-modal"):
        mobile = name == "mobile-modal"
        ctx, page = new_page(browser, name, mobile=mobile)
        page.goto(f"{BASE}/?demo=1")
        page.wait_for_timeout(3500)
        btn = page.locator(".block-active .del-btn").nth(1)
        btn.scroll_into_view_if_needed()
        btn.click()
        page.wait_for_timeout(1600)
        print("  focused:", page.evaluate("document.activeElement.textContent.trim()"))
        # Software (SwiftShader) compositing runs ~3 fps at 1440px, so the open
        # animation may still be pending: fast-forward finite animations.
        page.screenshot(path=str(OUT / f"{name}.png"), animations="disabled")
        page.keyboard.press("Tab")
        page.keyboard.press("Tab")
        page.keyboard.press("Tab")
        print("  focus after 3x Tab inside dialog:", page.evaluate("!!document.activeElement.closest('dialog')"))
        page.keyboard.press("Escape")
        page.wait_for_timeout(1500)
        print("  open after Esc:", page.evaluate("document.getElementById('confirm').open"), "focus back on:", page.evaluate("document.activeElement.className"))
        if not mobile:
            before = page.locator(".lead").count()
            btn.click()
            page.wait_for_timeout(500)
            page.locator("[data-act=confirm]").click()
            page.wait_for_timeout(400)
            page.screenshot(path=str(OUT / "modal-pending.png"))
            page.wait_for_timeout(2400)
            print("  leads before/after demo delete:", before, page.locator(".lead").count())
            page.screenshot(path=str(OUT / "modal-after-delete.png"))
        ctx.close()


def main():
    names = sys.argv[1:] or ["desktop", "why", "mobile", "empty", "intro", "reduced", "blocked", "nolibs", "modal", "mobile-modal"]
    with sync_playwright() as p:
        for name in names:
            # Fresh browser per scenario: SwiftShader's GPU process does not
            # survive many WebGL contexts in one headless session.
            browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=ARGS)
            print(f"== {name}")
            run(name, browser)
            browser.close()
    print("\nPROBLEMS:" if problems else "\nNo console errors/warnings or page errors.")
    for line in problems:
        print(" ", line)


if __name__ == "__main__":
    main()
