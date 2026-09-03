import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const statisticsPageStyles = readFileSync(resolve(process.cwd(), 'src/features/statistics/StatisticsPage.module.css'), 'utf8');

describe('continuous statistics dashboard layout', () => {
  it('uses responsive semantic sections without retaining tab styling', () => {
    const sectionsRule = statisticsPageStyles.match(/\.sections\s*{([^}]*)}/)?.[1];
    const dashboardSectionRule = statisticsPageStyles.match(/\.dashboardSection\s*{([^}]*)}/)?.[1];

    expect(statisticsPageStyles).not.toContain('.tabs');
    expect(sectionsRule).toContain('display: grid');
    expect(dashboardSectionRule).toContain('min-width: 0');
  });
});
