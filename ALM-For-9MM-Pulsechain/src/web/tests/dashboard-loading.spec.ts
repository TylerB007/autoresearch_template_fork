import { test, expect, Page } from '@playwright/test';

// --- Fixture data ---

const MOCK_DASHBOARD = {
  wallet: { address: '0xDeAd000000000000000000000000000000000000', plsBalance: '1234567' },
  positions: { total: 2, inRange: 1, outOfRange: 1 },
  botMode: 'DRY_RUN',
  positionList: [
    {
      tokenId: 155977,
      chainId: 369,
      chainName: 'PulseChain',
      pair: 'HEX/WPLS',
      strategy: 'center_6pct',
      inRange: true,
      currentTick: -12000,
      tickLower: -12500,
      tickUpper: -11500,
      token0Decimals: 8,
      token1Decimals: 18,
      positionValueUsd: 450.0,
    },
    {
      tokenId: 156145,
      chainId: 369,
      chainName: 'PulseChain',
      pair: 'HEX/WPLS',
      strategy: 'center_6pct',
      inRange: false,
      currentTick: -13000,
      tickLower: -12500,
      tickUpper: -11500,
      token0Decimals: 8,
      token1Decimals: 18,
      positionValueUsd: 380.0,
    },
  ],
  totalUnclaimedFeesUsd: 12.5,
  totalClaimableUsd: 12.5,
  walletTokens: [
    {
      symbol: 'HEX',
      address: '0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39',
      balance: '5000000000',
      decimals: 8,
      balanceFormatted: 50,
      valueUsd: 1.5,
      chainId: 369,
      chainName: 'PulseChain',
    },
  ],
};

const MOCK_PORTFOLIO = {
  totalValueUsd: 830.0,
  totalFeesEarnedUsd: 25.3,
  totalGasCostUsd: 0.12,
  netPnlUsd: 25.18,
  positions: [],
};

const MOCK_SONIC_REWARD_DASHBOARD = {
  wallet: { address: '0xDeAd000000000000000000000000000000000000', plsBalance: '1234567' },
  positions: { total: 1, inRange: 1, outOfRange: 0 },
  botMode: 'DRY_RUN',
  positionList: [
    {
      tokenId: 1143929,
      chainId: 146,
      chainName: 'Sonic',
      pair: 'USDC/WETH',
      strategy: 'center_6pct',
      inRange: true,
      currentTick: 100,
      tickLower: 50,
      tickUpper: 150,
      token0Decimals: 6,
      token1Decimals: 18,
      positionValueUsd: 924.11,
      totalFeesUsd: 0,
      unclaimedFeesUsd: 0,
      claimedFeesUsd: 0,
      totalEarningsUsd: 3.21,
      claimableRewardsUsd: 0.59,
      claimableYieldUsd: 0.59,
      rewardSymbols: ['SHADOW'],
    },
  ],
  totalUnclaimedFeesUsd: 0,
  totalClaimableUsd: 0.59,
  walletTokens: [],
};

// Inject a fake JWT so the AuthGuard passes (value doesn't need to be real since
// we also mock the /api/* routes and never hit a real server).
const FAKE_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0In0.fake';

async function injectAuth(page: Page) {
  await page.addInitScript((token: string) => {
    localStorage.setItem('alm_token', token);
  }, FAKE_TOKEN);
}

// --- Tests ---

test.describe('Dashboard loading states', () => {
  test('shows skeleton cards while API is loading, then renders real data', async ({ page }) => {
    // Intercept /api/dashboard — respond immediately
    await page.route('**/api/dashboard', async (route) => {
      await route.fulfill({ json: MOCK_DASHBOARD });
    });

    // Intercept /api/analytics/summary — delay 2s to simulate slow endpoint
    await page.route('**/api/analytics/summary', async (route) => {
      await new Promise((r) => setTimeout(r, 2000));
      await route.fulfill({ json: MOCK_PORTFOLIO });
    });

    // Intercept /api/recovery/status — respond immediately (no alert)
    await page.route('**/api/recovery/status', async (route) => {
      await route.fulfill({ json: { hasAlert: false } });
    });

    await injectAuth(page);
    await page.goto('/');

    // ── Phase 1: Skeleton phase ──────────────────────────────────────────────
    // The portfolio section should show animated skeleton placeholders immediately
    // while /api/analytics/summary is still pending.
    const skeletonText = page.getByText('Loading portfolio analytics...');
    await expect(skeletonText).toBeVisible({ timeout: 3000 });

    // The main dashboard stats (from fast /api/dashboard) should already be visible
    await expect(page.getByText('PLS Balance')).toBeVisible();
    await expect(page.getByText('1,234,567')).toBeVisible();
    await expect(page.getByText('Total Positions')).toBeVisible();
    await expect(page.getByText('2', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('In Range', { exact: true })).toBeVisible();

    // Position cards should be visible (rendered from dashboard data)
    await expect(page.getByRole('heading', { name: 'HEX/WPLS' }).first()).toBeVisible();

    // ── Phase 2: Real data phase ─────────────────────────────────────────────
    // Once analytics resolves, skeletons should disappear and real metric cards appear
    await expect(skeletonText).toBeHidden({ timeout: 5000 });

    await expect(page.getByText('Total Portfolio Value')).toBeVisible();
    await expect(page.getByText('$830.00')).toBeVisible();
    await expect(page.getByText('Total Fees Earned')).toBeVisible();
    await expect(page.getByText('Net P&L')).toBeVisible();
  });

  test('shows error state when analytics fails, keeps main dashboard visible', async ({ page }) => {
    await page.route('**/api/dashboard', async (route) => {
      await route.fulfill({ json: MOCK_DASHBOARD });
    });

    // Analytics fails with 504
    await page.route('**/api/analytics/summary', async (route) => {
      await route.fulfill({ status: 504, body: 'Gateway Timeout' });
    });

    await page.route('**/api/recovery/status', async (route) => {
      await route.fulfill({ json: { hasAlert: false } });
    });

    await injectAuth(page);
    await page.goto('/');

    // Main dashboard stats still visible
    await expect(page.getByText('PLS Balance')).toBeVisible();
    await expect(page.getByText('1,234,567')).toBeVisible();

    // Analytics error message shown instead of skeletons or real data
    await expect(
      page.getByText('Portfolio analytics unavailable — will retry on next refresh'),
    ).toBeVisible({ timeout: 5000 });

    // The real metric cards should NOT be visible
    await expect(page.getByText('Total Portfolio Value')).toBeHidden();
  });

  test('shows initial page skeleton while dashboard data loads', async ({ page }) => {
    // Both endpoints are slow — tests the initial full-page skeleton
    await page.route('**/api/dashboard', async (route) => {
      await new Promise((r) => setTimeout(r, 1500));
      await route.fulfill({ json: MOCK_DASHBOARD });
    });
    await page.route('**/api/analytics/summary', async (route) => {
      await new Promise((r) => setTimeout(r, 3000));
      await route.fulfill({ json: MOCK_PORTFOLIO });
    });
    await page.route('**/api/recovery/status', async (route) => {
      await route.fulfill({ json: { hasAlert: false } });
    });

    await injectAuth(page);
    await page.goto('/');

    // While dashboard is loading, the shimmer skeleton grid should be visible.
    // We check for the skeleton elements (animate-pulse divs) — the page renders
    // MetricCardSkeletons and PositionCardSkeletons during the loading state.
    const skeletons = page.locator('.animate-pulse');
    await expect(skeletons.first()).toBeVisible({ timeout: 2000 });

    // After dashboard data arrives, real content should appear
    await expect(page.getByText('PLS Balance')).toBeVisible({ timeout: 5000 });
    await expect(page.getByRole('heading', { name: 'HEX/WPLS' }).first()).toBeVisible();
  });

  test('shows recovery alert banner when stranded funds detected', async ({ page }) => {
    await page.route('**/api/dashboard', async (route) => {
      await route.fulfill({ json: MOCK_DASHBOARD });
    });
    await page.route('**/api/analytics/summary', async (route) => {
      await route.fulfill({ json: MOCK_PORTFOLIO });
    });
    await page.route('**/api/recovery/status', async (route) => {
      await route.fulfill({
        json: {
          hasAlert: true,
          report: {
            oldTokenId: 155900,
            token0Symbol: 'HEX',
            token1Symbol: 'WPLS',
            fee: 2500,
            strategy: 'center_6pct',
            widthTicks: 600,
            balance0: '50.00',
            balance1: '1000.00',
            timestamp: Date.now(),
          },
        },
      });
    });

    await injectAuth(page);
    await page.goto('/');

    // Recovery alert banner must be visible
    await expect(page.getByText('Stranded Funds Detected')).toBeVisible({ timeout: 3000 });
    await expect(page.getByText('#155900')).toBeVisible();
    await expect(page.getByText('Dismiss')).toBeVisible();
    await expect(page.getByText('Recover')).toBeVisible();

    // In DRY RUN mode the Recover button should be disabled
    const recoverBtn = page.getByRole('button', { name: 'Recover' });
    await expect(recoverBtn).toBeDisabled();
  });

  test('chain badges appear on position cards', async ({ page }) => {
    await page.route('**/api/dashboard', async (route) => {
      await route.fulfill({ json: MOCK_DASHBOARD });
    });
    await page.route('**/api/analytics/summary', async (route) => {
      await route.fulfill({ json: MOCK_PORTFOLIO });
    });
    await page.route('**/api/recovery/status', async (route) => {
      await route.fulfill({ json: { hasAlert: false } });
    });

    await injectAuth(page);
    await page.goto('/');

    // Wait for position cards to render
    await expect(page.getByRole('heading', { name: 'HEX/WPLS' }).first()).toBeVisible({ timeout: 3000 });

    // Chain badge should appear (Feature 4 — network identification)
    // PulseChain renders as "PLS" badge inside a small span with purple styling
    const chainBadge = page.locator('span.bg-purple-900\\/60').first();
    await expect(chainBadge).toBeVisible();
    await expect(chainBadge).toHaveText('PLS');
  });

  test('renders Sonic reward-backed earnings on position cards', async ({ page }) => {
    await page.route('**/api/dashboard', async (route) => {
      await route.fulfill({ json: MOCK_SONIC_REWARD_DASHBOARD });
    });
    await page.route('**/api/analytics/summary', async (route) => {
      await route.fulfill({ json: MOCK_PORTFOLIO });
    });
    await page.route('**/api/recovery/status', async (route) => {
      await route.fulfill({ json: { hasAlert: false } });
    });

    await injectAuth(page);
    await page.goto('/');

    const sonicCard = page.getByRole('button', { name: /1143929.*USDC\/WETH/i });
    await expect(sonicCard).toBeVisible({ timeout: 3000 });
    await expect(sonicCard.getByText('Earned')).toBeVisible();
    await expect(sonicCard.getByText('$3.21')).toBeVisible();
    await expect(sonicCard.getByText('Claimable')).toBeVisible();
    await expect(sonicCard.getByText('$0.59')).toBeVisible();
    await expect(page.getByText('Claimable Yield')).toBeVisible();
  });
});
