import { test, expect } from '@playwright/test';

// One-off live site check — visits https://143.110.130.198/ and captures screenshots
// to verify dashboard loading states on the real VPS.
// Run with: npx playwright test live-check --headed

test('live dashboard - login page loads', async ({ page }) => {
  test.setTimeout(90000);
  await page.goto('https://143.110.130.198/', { waitUntil: 'networkidle' });

  // Should redirect to /login if not authenticated
  await page.screenshot({ path: 'test-results/live-01-initial.png', fullPage: true });

  const url = page.url();
  console.log('Initial URL:', url);

  // If on login page, fill credentials and log in
  const passwordInput = page.locator('input[type="password"]');
  if (await passwordInput.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log('Login page detected — entering credentials...');
    // Password is read from env var DASHBOARD_PASSWORD so it's not hardcoded
    const password = process.env.DASHBOARD_PASSWORD;
    if (!password) {
      console.log('DASHBOARD_PASSWORD env var not set — skipping login');
      return;
    }
    await passwordInput.fill(password);
    await page.getByRole('button', { name: /sign in/i }).click();
    // Wait for redirect to dashboard (URL changes from /login to /)
    await page.waitForFunction(() => !window.location.pathname.includes('/login'), { timeout: 10000 });
  }

  // ── Skeleton phase ──────────────────────────────────────────────────────
  // Capture the skeleton loading state immediately after page load
  // (portfolio row shimmers while /api/analytics/summary builds its cache)
  await page.waitForLoadState('domcontentloaded');
  await page.screenshot({ path: 'test-results/live-02-skeleton.png', fullPage: true });
  console.log('Skeleton screenshot captured');

  // Verify the skeleton grid is visible (both rows of shimmer cards)
  const skeletons = page.locator('.animate-pulse');
  await expect(skeletons.first()).toBeVisible({ timeout: 5000 });
  console.log('Skeleton cards confirmed visible ✓');

  // Wait up to 90s for dashboard data to fully load (analytics cache build)
  await Promise.any([
    page.getByText('Total Portfolio Value').waitFor({ timeout: 90000 }),
    page.getByText('Portfolio analytics unavailable').waitFor({ timeout: 90000 }),
  ]).catch(() => console.log('Analytics still loading after 90s — cache may still be building'));

  await page.screenshot({ path: 'test-results/live-03-loaded.png', fullPage: true });
  console.log('Loaded state screenshot captured');

  // Core dashboard stats must be present regardless of analytics state
  await expect(page.getByText('PLS Balance')).toBeVisible({ timeout: 15000 });
  await expect(page.getByText('Total Positions')).toBeVisible();
  console.log('Core dashboard elements verified ✓');
});
