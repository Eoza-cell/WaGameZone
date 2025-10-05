import re
from playwright.sync_api import sync_playwright, expect

def run_verification():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()

        try:
            # Navigate to the local server
            page.goto("http://localhost:3000")

            # Wait for the QR code image to be visible
            qr_code_locator = page.locator("#qr-code")

            # The QR code src will be a data URL, so we check that it's not empty
            expect(qr_code_locator).to_have_attribute("src", re.compile(r"data:image/png;base64,.*"), timeout=20000)

            # Take a screenshot
            page.screenshot(path="jules-scratch/verification/verification.png")
            print("Screenshot taken successfully.")

        except Exception as e:
            print(f"An error occurred: {e}")
        finally:
            browser.close()

if __name__ == "__main__":
    run_verification()