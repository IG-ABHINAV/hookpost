import { aiCreditsLeftLabel, xPostsLeftLabel } from './plan.usage.copy';

describe('plan usage copy', () => {
  it('says what is left of the AI credits and what an image costs', () => {
    expect(aiCreditsLeftLabel({ left: 94, total: 100, imageCost: 5 })).toBe(
      '94 of 100 AI credits left · an image uses 5'
    );
    expect(aiCreditsLeftLabel({ left: 94, total: 100, cost: 5 })).toBe(
      '94 of 100 AI credits left · an image uses 5'
    );
    expect(aiCreditsLeftLabel({ left: 3, total: 100, cost: 1 })).toBe(
      '3 of 100 AI credits left'
    );
  });

  it('says what is left of the X posts, and that links are not included', () => {
    expect(xPostsLeftLabel({ left: 28, total: 30, linksAllowed: false })).toBe(
      '28 of 30 X posts left this month · no links on X'
    );
    expect(xPostsLeftLabel({ left: 49, total: 50, linksAllowed: true })).toBe(
      '49 of 50 X posts left this month'
    );
  });
});
