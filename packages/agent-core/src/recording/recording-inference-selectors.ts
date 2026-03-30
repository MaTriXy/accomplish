import type { SelectorStrategy } from '../common/types/recording.js';

export function buildSelectors(toolInput: Record<string, unknown>): SelectorStrategy[] | undefined {
  const selectors: SelectorStrategy[] = [];

  const pushSelector = (type: SelectorStrategy['type'], key: string, confidence: number): void => {
    if (typeof toolInput[key] === 'string' && toolInput[key].trim()) {
      selectors.push({ type, value: toolInput[key].trim() as string, confidence });
    }
  };

  pushSelector('css', 'selector', 0.95);
  pushSelector('xpath', 'xpath', 0.9);
  pushSelector('ref', 'ref', 0.9);
  pushSelector('text', 'text', 0.75);
  pushSelector('aria-label', 'ariaLabel', 0.8);
  pushSelector('test-id', 'testId', 0.85);

  const role = typeof toolInput.role === 'string' ? toolInput.role.trim() : '';
  const roleNameCandidates = ['name', 'label', 'ariaLabel']
    .map((key) => toolInput[key])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const roleName = roleNameCandidates.find((value) => Boolean(value.trim()));

  if (role) {
    selectors.push({
      type: 'aria-role',
      value: JSON.stringify({ role, name: roleName ?? null }),
      confidence: roleName ? 0.82 : 0.76,
    });
  }

  return selectors.length > 0 ? selectors : undefined;
}
