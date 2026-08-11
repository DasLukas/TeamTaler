import { describe, expect, it } from 'vitest';
import { memberPaths } from './paths';
import { router } from './router';

describe('member route contract', () => {
  it('exposes dedicated booking and overview routes', () => {
    expect(router.routesByPath[memberPaths.landing]).toBeDefined();
    expect(router.routesByPath[memberPaths.booking]).toBeDefined();
    expect(router.routesByPath[memberPaths.overview]).toBeDefined();
    expect(router.routesByPath[memberPaths.catalog]).toBeDefined();
    expect(router.routesByPath[memberPaths.finance]).toBeDefined();
    expect(router.routesByPath[memberPaths.legacyReports]).toBeDefined();
  });

  it('exposes account recovery and email confirmation routes', () => {
    expect(router.routesByPath['/forgot-password']).toBeDefined();
    expect(router.routesByPath['/reset-password']).toBeDefined();
    expect(router.routesByPath['/email-change/confirm']).toBeDefined();
  });
});
