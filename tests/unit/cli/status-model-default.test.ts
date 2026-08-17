/**
 * Unit coverage for the Model column in `cortextos status` output.
 *
 * When an agent has no explicit model override (AgentStatus.model unset),
 * the table must render a clear "default" label rather than a bare "-",
 * which is ambiguous with the pid/uptime "absent" fallbacks. An agent WITH
 * an explicit model must still render that model string verbatim.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { displayStatuses } from '../../../src/cli/status';
import type { AgentStatus } from '../../../src/types/index';

function captureOutput(statuses: AgentStatus[]): string {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  displayStatuses(statuses);
  const output = spy.mock.calls.map(c => c.join(' ')).join('\n');
  spy.mockRestore();
  return output;
}

describe('cortextos status: Model column', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders "default" when an agent has no explicit model', () => {
    const output = captureOutput([
      { name: 'alice', status: 'running', pid: 123, uptime: 42 },
    ]);
    // The row must render "default", not fall back to the ambiguous bare "-".
    expect(output).toContain('default');
    expect(output).not.toMatch(/running\s+123\s+42s\s+-\s*$/m);
  });

  it('renders an explicit model verbatim', () => {
    const output = captureOutput([
      { name: 'alice', status: 'running', pid: 123, uptime: 42, model: 'claude-opus-4-8' },
    ]);
    expect(output).toContain('claude-opus-4-8');
    expect(output).not.toContain('default');
  });
});
