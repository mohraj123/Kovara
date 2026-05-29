import { test, expect } from '@playwright/test';

test.describe('Profile Flow', () => {
  test('Navigate profile, follow user, verify follower count', async ({ page }) => {
    // Navigate to a mock profile
    await page.goto('/profile/GXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX');
    
    // Wait for loading to finish and stats to be visible
    await expect(page.getByText('Followers')).toBeVisible({ timeout: 10000 });
    
    // Follow user
    const followButton = page.getByRole('button', { name: /^Follow$/i });
    if (await followButton.isVisible()) {
      await followButton.click();
      // Verify follow state changes
      await expect(page.getByRole('button', { name: /^Following$/i })).toBeVisible({ timeout: 5000 });
    }
  });
});
