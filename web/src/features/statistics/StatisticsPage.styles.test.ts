import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const statisticsPageStyles = readFileSync(resolve(process.cwd(), 'src/features/statistics/StatisticsPage.module.css'), 'utf8');

describe('statistics tab focus geometry', () => {
  it('keeps the contained focus ring clear of the label without widening the active underline', () => {
    const tabButtonRule = statisticsPageStyles.match(/\.tabs button\s*{([^}]*)}/)?.[1];
    const activeUnderlineRule = statisticsPageStyles.match(/\.tabs \.activeTab::after\s*{([^}]*)}/)?.[1];
    const focusRule = statisticsPageStyles.match(/\.tabs button:focus-visible\s*{([^}]*)}/)?.[1];

    expect(tabButtonRule).toContain('padding: 0 var(--space-2)');
    expect(activeUnderlineRule).toContain('inset: auto var(--space-2) 0');
    expect(focusRule).toContain('outline-offset: -3px');
  });
});
