// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { DeviceRow } from '../src/components/DeviceRow';
import { leaseLabel } from '../src/stateColor';
import type { DeviceData } from '../src/types';

const NOW = 1_700_000_000_000;

const makeDev = (overrides: Partial<DeviceData>): DeviceData => ({
  id: 'serial-A',
  model: 'TECNO LH7n',
  serial: 'ABC123XYZ',
  status: 'device',
  battery: { level: 80, charging: false },
  ...overrides,
} as any);

describe('DeviceRow — lease TTL countdown', () => {
  it('shows the initial lease TTL correctly', () => {
    const onToggle = vi.fn();
    const onOpen = vi.fn();
    const d = makeDev({ leaseState: 'leased', leasedBy: 'ci', leaseExpiresAt: NOW + 47_000 });
    const { container } = render(
      <DeviceRow
        device={d}
        isSelected={false}
        onToggleSelect={onToggle}
        onOpenDetail={onOpen}
        now={NOW}
      />,
    );
    expect(container.textContent).toContain('ci (47s)');
  });

  it('renders TTL warning when countdown is <= 60s', () => {
    const d = makeDev({ leaseState: 'leased', leasedBy: 'ci', leaseExpiresAt: NOW + 30_000 });
    const { container } = render(
      <DeviceRow
        device={d}
        isSelected={false}
        onToggleSelect={() => {}}
        onOpenDetail={() => {}}
        now={NOW}
      />,
    );
    expect(container.textContent).toContain('TTL expires soon');
  });

  it('does NOT render TTL warning when countdown is > 60s', () => {
    const d = makeDev({ leaseState: 'leased', leasedBy: 'ci', leaseExpiresAt: NOW + 5 * 60_000 });
    const { container } = render(
      <DeviceRow
        device={d}
        isSelected={false}
        onToggleSelect={() => {}}
        onOpenDetail={() => {}}
        now={NOW}
      />,
    );
    expect(container.textContent).not.toContain('TTL expires soon');
  });

  it('renders the lease ticker countdown live (advances every second)', () => {
    vi.useFakeTimers();
    try {
      const d = makeDev({ leaseState: 'leased', leasedBy: 'ci', leaseExpiresAt: NOW + 10_000 });
      const { container } = render(
        <DeviceRow
          device={d}
          isSelected={false}
          onToggleSelect={() => {}}
          onOpenDetail={() => {}}
          now={NOW}
        />,
      );
      expect(container.textContent).toContain('ci (10s)');
      act(() => { vi.advanceTimersByTime(3_000); });
      expect(container.textContent).toContain('ci (7s)');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start a ticker for non-leased states (no setInterval)', () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    try {
      const d = makeDev({ leaseState: 'available' });
      render(
        <DeviceRow
          device={d}
          isSelected={false}
          onToggleSelect={() => {}}
          onOpenDetail={() => {}}
          now={NOW}
        />,
      );
      expect(setIntervalSpy).not.toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe('DeviceRow — interactions', () => {
  it('invokes onOpenDetail when the row is clicked', () => {
    const onOpen = vi.fn();
    const d = makeDev({ id: 'serial-XYZ' });
    const { container } = render(
      <DeviceRow
        device={d}
        isSelected={false}
        onToggleSelect={() => {}}
        onOpenDetail={onOpen}
        now={NOW}
      />,
    );
    const row = container.querySelector('[data-testid="device-row-serial-XYZ"]')!;
    fireEvent.click(row);
    expect(onOpen).toHaveBeenCalledWith('serial-XYZ');
  });

  it('select checkbox toggles without opening the detail', () => {
    const onToggle = vi.fn();
    const onOpen = vi.fn();
    const d = makeDev({ id: 'serial-XYZ' });
    const { container } = render(
      <DeviceRow
        device={d}
        isSelected={false}
        onToggleSelect={onToggle}
        onOpenDetail={onOpen}
        now={NOW}
      />,
    );
    const checkbox = container.querySelector('input[type="checkbox"]')!;
    fireEvent.click(checkbox);
    expect(onToggle).toHaveBeenCalledWith('serial-XYZ');
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('DeviceRow — quarantine reason inline', () => {
  it('shows the first reason inline when quarantined', () => {
    const d = makeDev({ leaseState: 'quarantined' });
    const { container } = render(
      <DeviceRow
        device={d}
        health={{ healthScore: 30, reasons: ['getProperties failure rate 80%', 'reconnects high'], leaseState: 'quarantined' }}
        isSelected={false}
        onToggleSelect={() => {}}
        onOpenDetail={() => {}}
        now={NOW}
      />,
    );
    expect(container.textContent).toContain('getProperties failure rate 80%');
  });

  it('truncates long reasons to 57 chars + ellipsis', () => {
    const long = 'x'.repeat(120);
    const d = makeDev({ leaseState: 'quarantined' });
    const { container } = render(
      <DeviceRow
        device={d}
        health={{ healthScore: 30, reasons: [long], leaseState: 'quarantined' }}
        isSelected={false}
        onToggleSelect={() => {}}
        onOpenDetail={() => {}}
        now={NOW}
      />,
    );
    expect(container.textContent).toContain('x'.repeat(57) + '…');
  });
});

describe('leaseLabel — additional edge cases', () => {
  it('property: countdownSec is non-negative for any lease expiry', () => {
    for (const off of [-1_000_000, -1, 0, 1, 60_000]) {
      const r = leaseLabel('leased', 'who', NOW + off, NOW);
      expect(r.countdownSec).toBeGreaterThanOrEqual(0);
    }
  });
});