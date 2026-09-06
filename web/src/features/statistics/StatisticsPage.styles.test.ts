import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const statisticsPageStyles = readFileSync(resolve(process.cwd(), 'src/features/statistics/StatisticsPage.module.css'), 'utf8');
const workspaceTabStyles = readFileSync(resolve(process.cwd(), 'src/components/ui/WorkspaceTabs.module.css'), 'utf8');

describe('tabbed statistics dashboard layout', () => {
  it('uses the shared responsive workspace tabs and hides inactive panels', () => {
    const tabsRule = workspaceTabStyles.match(/\.tabs\s*{([^}]*)}/)?.[1];
    const sectionsRule = statisticsPageStyles.match(/\.sections\s*{([^}]*)}/)?.[1];
    const dashboardSectionRule = statisticsPageStyles.match(/\.dashboardSection\s*{([^}]*)}/)?.[1];
    const hiddenPanelRule = statisticsPageStyles.match(/\.tabPanel\[hidden\]\s*{([^}]*)}/)?.[1];

    expect(tabsRule).toContain('display: flex');
    expect(tabsRule).toContain('overflow-x: auto');
    expect(workspaceTabStyles).toContain('.tabs .activeTab');
    expect(workspaceTabStyles).toContain('min-height: 48px');
    expect(workspaceTabStyles).toContain("background: var(--color-brand)");
    expect(workspaceTabStyles).toContain('margin-inline: calc(var(--space-5) * -1)');
    expect(sectionsRule).toContain('display: grid');
    expect(dashboardSectionRule).toContain('min-width: 0');
    expect(hiddenPanelRule).toContain('display: none');
  });
});
